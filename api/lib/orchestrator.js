// api/lib/orchestrator.js — Central orchestration engine
// Manages all distributed nodes, load balancing, circuit breakers, rate limits, cost tracking

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NODES_FILE = path.join(__dirname, '..', 'data', 'nodes.json');

class Orchestrator {
  constructor() {
    // Core state
    this.nodes = new Map();           // nodeId -> node info + live stats
    this.tasks = new Map();           // taskId -> task queue item
    this.activeStreams = new Map();   // streamId -> stream metadata
    this.thinkTasks = new Map();      // thinkId -> inference state

    // Load persisted nodes
    this._loadNodes();

    // Routing config (all controllable via dashboard)
    this.config = {
      loadBalancing: 'least-load',       // round-robin | weighted | least-load | capacity-aware | latency-affected
      maxConcurrentPerNode: 10,
      failoverEnabled: true,
      cascadeProtection: true,
      heartbeatIntervalMs: 15000,
      staleThresholdMs: 180000,          // 3 min
      taskTimeoutMs: 300000,             // 5 min
      enableStreaming: true,
      maxStreamConsumers: 100,
      defaultFanOutCount: 1,
      allowCrossRoleFallback: false,
      modelAffinity: new Map(),          // modelName -> preferred nodeIds
      canaryPercent: 0                    // % traffic to test models
    };

    // Circuit breakers
    this.circuitBreakers = new Map();   // nodeId/modelKey -> state

    // Rate limits — global + per-node + per-user
    this.rateLimits = {
      global: { rpm: 0, rpd: 0, rpm_: 0 },     // requests per minute/day/month (0 = unlimited)
      perNode: {},                             // nodeId -> { rpm, rpd, rpm_ }
      perUser: {}                              // userId -> { rpm, rpd, rpm_, tokens_per_hour, tokens_per_day, tokens_per_month }
    };

    // Quota tracking
    this.quotas = {
      userTokensUsed: new Map(),       // userId -> { monthly, daily, hourly }
      nodeRequests: new Map(),         // nodeId -> { today, thisHour }
      totalTokensToday: 0,
      totalRequestsToday: 0,
      totalCostToday: 0
    };

    // Request logs
    this.requestLog = [];              // in-memory ring buffer
    this.maxLogEntries = 10000;

    // Cost tracking
    this.costs = {
      perProvider: {},                 // providerName -> { inputTokens, outputTokens, estimatedCost }
      perModel: {},                    // model -> same structure
      perUser: {},                     // userId -> totalCost
      perNode: {},                     // nodeId -> totalTokensProcessed
      unitPrices: {                  // $ per 1M tokens
        providers: {},                // override per-provider pricing
        models: {},                   // override per-model pricing
        defaults: {
          ollama: { input: 0, output: 0 },
          'lm-studio': { input: 0, output: 0 },
          openai: { input: 2.50, output: 10.00 },
          anthropic: { input: 3.75, output: 15.00 },
          google: { input: 1.25, output: 5.00 },
          general: { input: 0.50, output: 2.00 }
        }
      }
    };

    // Alerts & thresholds
    this.alerts = {
      enabled: true,
      channels: [],                  // email, webhook, slack, pagerduty
      thresholds: {
        cpuCritical: 95,             // % — triggers critical alert
        cpuWarning: 85,              // % — warning
        memCritical: 90,             // %
        memWarning: 80,
        gpuVramCritical: 95,         // %
        gpuVramWarning: 80,
        diskCritical: 90,            // % used
        diskWarning: 80,
        queueDepthCritical: 50,      // pending tasks
        queueDepthWarning: 25,
        latencyP95TargetMs: 5000,    // ms
        errorRateCritical: 0.1,      // 10%
        errorRateWarning: 0.05       // 5%
      },
      activeAlerts: [],
      suppressionWindows: [],        // { until, reason }
      escalationLevels: { warning: 1, critical: 2 }
    };

    // Node health history for trend analysis
    this.healthHistory = new Map();   // nodeId -> [{ timestamp, cpu, mem, disk, latency, errors }]
    this.maxHistoryPoints = 1440;      // 24h at 1-min intervals

    // Start background tasks
    this.startHeartbeatMonitor();
    this.startCleanup();
    this.startAlertChecks();
    this.startHistoryRecorder();
  }

  // ---- Node Persistence (survive gateway restarts) ----
  _loadNodes() {
    try {
      if (fs.existsSync(NODES_FILE)) {
        const data = JSON.parse(fs.readFileSync(NODES_FILE, 'utf8'));
        for (const [id, node] of Object.entries(data)) {
          // A fresh persisted heartbeat is as good as a live one. Blanket-marking
          // everything 'stale' made the WHOLE fleet render stale for up to a
          // heartbeat cycle after every gateway restart (and tripped node_stale
          // incidents for healthy nodes). Nodes with no recent heartbeat still
          // prove themselves as before.
          // NOTE: this.config doesn't exist yet — the constructor calls us at
          // line 19, before config is assigned at line 22 — so 180000 mirrors
          // config.staleThresholdMs rather than reading it.
          const age = node.last_heartbeat ? Date.now() - node.last_heartbeat : Infinity;
          node.status = age <= 180000 ? 'online' : 'stale';
          this.nodes.set(id, node);
        }
        console.log(`[ORCH] Loaded ${this.nodes.size} persisted node(s)`);
      }
    } catch (e) {
      console.error('[ORCH] Failed to load nodes:', e.message);
    }
  }

  _saveNodes() {
    try {
      const dir = path.dirname(NODES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {};
      for (const [id, node] of this.nodes) {
        // Strip non-serializable fields
        data[id] = { ...node };
      }
      fs.writeFileSync(NODES_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[ORCH] Failed to save nodes:', e.message);
    }
  }

  _debouncedSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNodes();
    }, 10000); // save at most once per 10s
  }

  // ---- Usage Tracking ----
  trackRequest(tokens, cost = 0, provider = 'unknown', model = null, userId = null) {
    this.quotas.totalRequestsToday = (this.quotas.totalRequestsToday || 0) + 1;
    this.quotas.totalTokensToday = (this.quotas.totalTokensToday || 0) + (tokens || 0);
    this.costs.totalCostToday = (this.costs.totalCostToday || 0) + (cost || 0);
    if (provider) {
      if (!this.costs.perProvider[provider]) {
        this.costs.perProvider[provider] = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
      }
      this.costs.perProvider[provider].inputTokens += (tokens || 0);
    }
  }

  // ---- Node Management ----

  registerNode(nodeData) {
    let nodeId = nodeData.token || nodeData.id;
    const now = Date.now();
    const STALE_MS = 300000; // 5 minutes

    // If a node with this name already exists, handle collision
    if (this.nodes.has(nodeId)) {
      const existingNode = this.nodes.get(nodeId);
      const existingAge = now - (existingNode.last_heartbeat || 0);

      // Same machine re-registering (same hw_id) — just update
      if (existingNode.hw_id && nodeData.hw_id && existingNode.hw_id === nodeData.hw_id) {
        // Same machine, keep same ID
      }
      // Old node is stale (no heartbeat in 5+ min) — replace it
      else if (existingAge > STALE_MS) {
        console.log(`[ORCH] Replacing stale node: ${nodeId} (last heartbeat ${Math.round(existingAge/1000)}s ago)`);
      }
      // Different machine with same hostname — append short LAN octet
      else {
        const lanIp = nodeData.lan_ip || nodeData.ip || '';
        const octet = lanIp.split('.').pop() || nodeId.slice(-4);
        nodeId = `${nodeId}-${octet}`;
      }
    }

    // Preserve existing if re-registering
    const existing = this.nodes.get(nodeId);
    const isNew = !existing;

    const incoming = nodeData.system || {};
    // Populate system info from metrics if available at registration time
    if (nodeData.metrics) {
      if (nodeData.metrics.cpu_count) incoming.cpus = nodeData.metrics.cpu_count;
      if (nodeData.metrics.cpu_freq_mhz) incoming.cpu_freq_mhz = nodeData.metrics.cpu_freq_mhz;
      if (nodeData.metrics.mem_total_mb) incoming.memory_total = nodeData.metrics.mem_total_mb * 1024 * 1024;
      if (nodeData.metrics.disk_total_gb) incoming.disk_total = Math.round(nodeData.metrics.disk_total_gb * 1024 * 1024 * 1024);
    }
    if (nodeData.cpu_model) incoming.cpu_model = nodeData.cpu_model;
    if (nodeData.location) incoming.location = nodeData.location;

    this.nodes.set(nodeId, {
      node_id: nodeId,
      token: nodeData.token,
      // Preserve the node secret + enrolment across re-registration: this
      // object is rebuilt on EVERY register call, and losing either one makes
      // the bee's inbox enforcement flap (secret_seen → None) and breaks HMAC
      // verification of repair plans. Same treatment as tools/registered_at.
      secret: nodeData.secret || existing?.secret,
      secret_seen: existing?.secret_seen || false,
      hw_id: nodeData.hw_id || existingNode?.hw_id || '',
      name: nodeData.name || `node-${nodeId.slice(0,6)}`,
      ip: nodeData.ip || nodeData.lan_ip || '',
      version: nodeData.version || '2.0.0',
      capabilities: nodeData.capabilities || [],
      volunteer: nodeData.volunteer ?? existing?.volunteer ?? false,
      local_models: nodeData.local_models || [],
      system: incoming,
      max_concurrent_jobs: nodeData.max_concurrent_jobs || 10,
      status: 'online',
      // Local tools server — preserve prior share if the (re)register omits it,
      // so an agent restart that hasn't re-announced yet doesn't wipe the tools
      tools: Array.isArray(nodeData.tools) ? nodeData.tools : (existing?.tools || []),
      tools_port: nodeData.tools_port || existing?.tools_port || 0,
      registered_at: existing?.registered_at || now,
      last_heartbeat: now,
      volunteer: nodeData.volunteer ?? existing?.volunteer ?? false,
      cum: existing?.cum || null,
      last_result_type: null,
      tasks_completed: existing?.tasks_completed || 0,
      tasks_failed: existing?.tasks_failed || 0,
      total_tokens_processed: existing?.total_tokens_processed || 0,
      // Live metrics (updated by heartbeat)
      current_load: { cpu: 0, mem: 0, active_jobs: 0 },
      total_cpu_percent: 0,
      total_mem_percent: 0,
      active_tasks: 0,
      uptime_seconds: 0,
      total_cost: 0,
      // Hardware & location
      lan_ip: nodeData.lan_ip || '',
      location: nodeData.location || {},
      cpu_model: nodeData.cpu_model || '',
      // Collaboration
      work_status: nodeData.work_status || '',
      current_problem_id: nodeData.current_problem_id || null,
      last_status_update: nodeData.work_status ? now : null
    });

    // Init rate limit if not set
    if (!this.rateLimits.perNode[nodeId]) {
      this.rateLimits.perNode[nodeId] = { rpm: 0, rpd: 0, rpm_: 0 };
    }

    if (isNew) {
      console.log(`[ORCH] New node online: ${nodeId} (${nodeData.ip}) caps: ${nodeData.capabilities?.slice(0,3).join(', ')}`);
    } else {
      console.log(`[ORCH] Node re-registered: ${nodeId}`);
    }

    this._saveNodes();
    return this.nodes.get(nodeId);
  }

  updateHeartbeat(nodeId, data, opts = {}) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;

    node.last_heartbeat = Date.now();
    if (opts.public_ip) node.public_ip = opts.public_ip;
    if (data.version) node.version = data.version;
    if (data.volunteer !== undefined) node.volunteer = data.volunteer;
    // tools sharing is re-announced every heartbeat — survives restarts (F7).
    // An empty array means "server down / not sharing" and un-shares cleanly.
    if (Array.isArray(data.tools)) {
      node.tools = data.tools;
      node.tools_port = data.tools.length ? (data.tools_port || node.tools_port || 0) : 0;
    }
    // monotonic cumulative counters from the agent (survive gateway restarts &
    // re-registrations; the honey sweep prefers these over in-memory deltas)
    if (data.cumulative && typeof data.cumulative === 'object') {
      const c = node.cum || {};
      node.cum = {
        tasks_completed: Math.max(c.tasks_completed || 0, data.cumulative.tasks_completed || 0),
        tokens_processed: Math.max(c.tokens_processed || 0, data.cumulative.tokens_processed || 0),
      };
    }
    // Metrics live in data.metrics (from CLI's _collect_metrics())
    const m = data.metrics || {};
    node.metrics = { ...node.metrics, ...m };
    node.total_cpu_percent = m.cpu_percent ?? node.total_cpu_percent;
    node.total_mem_percent = m.mem_pct ?? node.total_mem_percent;
    node.uptime_seconds = m.uptime_s ?? node.uptime_seconds;
    node.active_tasks = data.jobs ?? m.active_jobs ?? 0;
    node.status = this.getNodeStatus(node);
    if (data.work_status !== undefined) {
      node.work_status = data.work_status;
      node.last_status_update = Date.now();
    }
    if (data.current_problem_id !== undefined) {
      node.current_problem_id = data.current_problem_id;
    }
    // Hardware/location — update if provided (some nodes get detected after registration)
    if (data.lan_ip) node.lan_ip = data.lan_ip;
    if (data.location && Object.keys(data.location).length > 0) node.location = data.location;
    if (data.cpu_model) node.cpu_model = data.cpu_model;
    if (m.gpus) node.gpus = m.gpus;
    // Per-node stats (from local AI jobs run on this node)
    if (data.stats) {
      node.stats = node.stats || {};
      node.stats.tasks_completed = (node.stats.tasks_completed || 0) + (data.stats.tasks_completed || 0);
      node.stats.tasks_failed = (node.stats.tasks_failed || 0) + (data.stats.tasks_failed || 0);
      node.stats.total_tokens_processed = (node.stats.total_tokens_processed || 0) + (data.stats.total_tokens_processed || 0);
      node.stats.total_cost = (node.stats.total_cost || 0) + (data.stats.total_cost || 0);
      node.stats.total_requests = (node.stats.total_requests || 0) + (data.stats.total_requests || 0);
    }
    // Persist nodes periodically (debounced — max once per 30s)
    this._debouncedSave();
    return node;
  }

  getNodeStatus(node) {
    const age = Date.now() - node.last_heartbeat;
    if (age > this.config.staleThresholdMs) return 'offline';
    if (node.total_cpu_percent > 95 || node.total_mem_percent > 90) return 'stressed';
    return 'online';
  }

  getOnlineNodes(options = {}) {
    const { role, capability, excludeStressed = false } = options;
    return Array.from(this.nodes.values()).filter(n => {
      if (n.status === 'offline') return false;
      if (excludeStressed && n.status === 'stressed') return false;
      if (role && !n.capabilities.includes(role)) return false;
      if (capability && !n.capabilities.includes(capability)) return false;
      return true;
    });
  }

  getGlobalStats() {
    const all = Array.from(this.nodes.values());
    const online = all.filter(n => n.status !== 'offline');
    const stressed = all.filter(n => n.status === 'stressed');
    const offline = all.filter(n => n.status === 'offline');

    const totalCpus = online.reduce((s, n) => s + (n.metrics?.cpu_count || n.system?.cpus || 0), 0);
    const totalMemGB = online.reduce((s, n) => s + ((n.metrics?.mem_total_mb || 0) / 1024), 0);
    const freeMemGB = online.reduce((s, n) => s + ((n.metrics?.mem_avail_mb || 0) / 1024), 0);
    const totalModels = online.reduce((s, n) => s + (n.local_models?.length || 0), 0);
    const totalWorkers = online.reduce((s, n) => s + (n.max_concurrent_jobs || 0), 0);
    const activeJobs = online.reduce((s, n) => s + (n.active_tasks || 0), 0);
    // Aggregate from node stats (updated by heartbeat)
    const stats = (n) => n.stats || {};
    const totalCompleted = online.reduce((s, n) => s + (stats(n).tasks_completed || n.tasks_completed || 0), 0);
    const totalFailed = online.reduce((s, n) => s + (stats(n).tasks_failed || n.tasks_failed || 0), 0);
    const totalTokens = online.reduce((s, n) => s + (stats(n).total_tokens_processed || n.total_tokens_processed || 0), 0);
    const totalCost = online.reduce((s, n) => s + (stats(n).total_cost || 0), 0);
    const totalRequests = online.reduce((s, n) => s + (stats(n).total_requests || 0), 0);
    // Sum uptime across online nodes to compute tokens/sec
    const totalUptimeS = online.reduce((s, n) => s + (n.metrics?.uptime_s || n.uptime_seconds || 0), 0);
    const tokensPerSecond = totalUptimeS > 0 ? (totalTokens / totalUptimeS) : 0;

    return {
      timestamp: Date.now(),
      cluster: {
        total_nodes: all.length,
        online: online.length,
        stressed: stressed.length,
        offline: offline.length
      },
      capacity: {
        total_cpus: totalCpus,
        total_memory_gb: totalMemGB.toFixed(1),
        free_memory_gb: freeMemGB.toFixed(1),
        total_models: totalModels,
        total_workers: totalWorkers,
        active_jobs: activeJobs,
        available_capacity: totalWorkers - activeJobs,
        utilization_percent: totalWorkers > 0 ? ((activeJobs / totalWorkers) * 100).toFixed(1) : 0
      },
      performance: {
        // Hub-level counters (updated every time a request goes through the hub)
        total_requests_today: this.quotas?.totalRequestsToday || 0,
        total_tokens_today: this.quotas?.totalTokensToday || 0,
        total_cost_today: this.costs?.totalCostToday || 0,
        // All-time aggregated from nodes (distributed AI jobs run on nodes)
        total_all_time_completions: totalCompleted,
        total_all_time_tokens: totalTokens,
        tokens_per_second: parseFloat(tokensPerSecond.toFixed(2)),
        tasks_failed: totalFailed
      },
      circuit_breakers: this.getCircuitBreakerSummary(),
      queued_tasks: this.tasks.size
    };
  }

  // ---- Load Balancing ----

  async selectNode(taskType, options = {}) {
    const { preferredModel, fallbackChain, allowOffline = false } = options;
    let candidates = this.getOnlineNodes({ capability: taskType });

    // Apply canary routing
    if (this.config.canaryPercent > 0) {
      const testNodes = this.getTestNodes();
      if (Math.random() < this.config.canaryPercent / 100 && testNodes.length > 0) {
        candidates = testNodes;
      }
    }

    if (candidates.length === 0) return null;

    switch(this.config.loadBalancing) {
      case 'round-robin':
        return this.roundRobinSelect(candidates);
      case 'weighted':
        return this.weightedSelect(candidates);
      case 'least-load':
        return this.leastLoadSelect(candidates);
      case 'capacity-aware':
        return this.capacityAwareSelect(candidates);
      case 'latency-affected':
        return await this.latencyAffectedSelect(candidates);
      default:
        return this.leastLoadSelect(candidates);
    }
  }

  roundRobinSelect(candidates) {
    // Simple: pick next in rotation
    const key = candidates.map(n => n.node_id).sort().join(',');
    if (!this._rrLastKey || this._rrLastKey !== key) {
      this._rrIndex = 0;
      this._rrLastKey = key;
    }
    const idx = this._rrIndex % candidates.length;
    this._rrIndex++;
    return candidates[idx];
  }

  weightedSelect(candidates) {
    // Weight based on inverse of current load (less loaded = higher weight)
    const totalWeight = candidates.reduce((s, n) => {
      const load = (n.total_cpu_percent || 50) + (n.total_mem_percent || 50);
      return s + Math.max(0, 100 - load);
    }, 0);
    if (totalWeight <= 0) return candidates[Math.floor(Math.random() * candidates.length)];
    let r = Math.random() * totalWeight;
    for (const n of candidates) {
      const load = (n.total_cpu_percent || 50) + (n.total_mem_percent || 50);
      const w = Math.max(0, 100 - load);
      r -= w;
      if (r <= 0) return n;
    }
    return candidates[candidates.length - 1];
  }

  leastLoadSelect(candidates) {
    return candidates.sort((a, b) => {
      const aLoad = (a.total_cpu_percent || 0) + (a.total_mem_percent || 0);
      const bLoad = (b.total_cpu_percent || 0) + (b.total_mem_percent || 0);
      return aLoad - bLoad;
    })[0];
  }

  capacityAwareSelect(candidates) {
    // Factor in CPU, memory, and available worker slots
    return candidates.sort((a, b) => {
      const score = (n) => {
        const cpuScore = (n.total_cpu_percent || 0) * 0.4;
        const memScore = (n.total_mem_percent || 0) * 0.3;
        const workerScore = ((n.max_concurrent_jobs || 1) - (n.active_tasks || 0)) / (n.max_concurrent_jobs || 1) * 100 * 0.3;
        return cpuScore + memScore + (100 - workerScore);
      };
      return score(a) - score(b);
    })[0];
  }

  async latencyAffectedSelect(candidates) {
    // Sort by average recent latency (prefer fastest nodes)
    const withLatency = await Promise.all(candidates.map(async n => {
      try {
        const t0 = Date.now();
        await fetch(`http://${n.ip}:8899/health`, { signal: AbortSignal.timeout(1000) });
        return { node: n, latency_ms: Date.now() - t0 };
      } catch(e) {
        return { node: n, latency_ms: 9999 };
      }
    }));
    withLatency.sort((a, b) => a.latency_ms - b.latency_ms);
    return withLatency[0]?.node || candidates[0];
  }

  getTestNodes() {
    return this.getOnlineNodes().filter(n => {
      return n.tags?.includes('test') || n.tags?.includes('canary') || false;
    });
  }

  // ---- Task Queue ----

  enqueueTask(task) {
    const taskId = crypto.randomUUID().slice(0, 8);
    const taskItem = {
      id: taskId,
      type: task.type || task.task_type,
      payload: task.payload || task.data || {},
      model: task.model,
      priority: task.priority || 'normal', // low | normal | high | urgent
      source: task.source || 'api',
      created_at: Date.now(),
      assigned_to: null,
      status: 'pending',       // pending → running → completed | failed
      retries: 0,
      max_retries: 3,
      result: null,
      error: null
    };
    this.tasks.set(taskId, taskItem);

    // Dispatch immediately if nodes available
    this.dispatchTask(taskId);

    return taskId;
  }

  async dispatchTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return;

    const node = await this.selectNode(task.type, { preferredModel: task.model });
    if (!node) {
      // No nodes available — keep in queue
      return;
    }

    // Check circuit breaker
    if (this.isCircuitOpen(node.node_id, task.model)) {
      return; // Skip to next candidate
    }

    task.status = 'running';
    task.assigned_to = node.node_id;
    task.attempted_at = Date.now();

    // POST task to node's /dispatch endpoint
    this.sendTaskToNode(node, task);
  }

  sendTaskToNode(node, task) {
    const http = require('http');
    const payload = JSON.stringify({
      id: task.id,
      type: task.type,
      payload: task.payload,
      model: task.model,
      options: task.options,
      source: task.source
    });
    const data = Buffer.from(payload);

    const opts = {
      hostname: node.ip,
      port: 8899,
      path: '/dispatch',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-Task-ID': task.id,
        'X-Source': task.source
      }
    };

    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          this.handleTaskFailure(task.id, `Node returned ${res.statusCode}`);
        }
      });
    });

    req.on('error', (err) => {
      this.handleTaskFailure(task.id, err.message);
      // Trip circuit breaker for this node
      this.tripCircuitBreaker(node.node_id);
    });

    req.on('timeout', () => {
      req.destroy();
      this.handleTaskFailure(task.id, 'Request timeout');
    });

    req.setTimeout(300000); // 5 min
    req.write(data);
    req.end();
  }

  handleTaskSuccess(taskId, result) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'completed';
    task.result = result;
    task.completed_at = Date.now();

    // Update node stats
    const node = this.nodes.get(task.assigned_to);
    if (node) {
      node.tasks_completed++;
      node.total_tokens_processed += (result.tokens_in || 0) + (result.tokens_out || 0);
      this.updateNodeCost(task, result);
    }

    // Log request
    this.logRequest(task, result);
    this.untripCircuitBreaker(task.assigned_to);
  }

  handleTaskFailure(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.retries++;
    if (task.retries <= task.max_retries && this.config.failoverEnabled) {
      // Retry with different node
      task.status = 'pending';
      this.tasks.set(taskId, task);
      setTimeout(() => this.dispatchTask(taskId), 1000 * task.retries);
    } else {
      task.status = 'failed';
      task.error = error;
      task.failed_at = Date.now();
      const node = this.nodes.get(task.assigned_to);
      if (node) node.tasks_failed++;
      this.logRequest(task, { error });
      this.tripCircuitBreaker(task.assigned_to);
    }
  }

  getQueuedTasks(options = {}) {
    const { role, limit = 50 } = options;
    return Array.from(this.tasks.values())
      .filter(t => {
        if (t.status !== 'pending' && t.status !== 'running') return false;
        if (role && t.type !== role) return false;
        return true;
      })
      .slice(0, limit);
  }

  // ---- Circuit Breaker ----

  isCircuitOpen(nodeId, modelKey) {
    const key = `${nodeId}:${modelKey || '*'}`;
    const cb = this.circuitBreakers.get(key);
    if (!cb) return false;

    if (cb.state === 'open') {
      if (Date.now() - cb.opened_at > 30000) {
        cb.state = 'half-open';
      }
      return cb.state === 'open';
    }
    return false;
  }

  tripCircuitBreaker(nodeId, modelKey) {
    const key = `${nodeId}:${modelKey || '*'}`;
    const cb = this.circuitBreakers.get(key);
    if (cb && cb.state === 'half-open') return; // already probing
    this.circuitBreakers.set(key, {
      state: 'open',
      failures: (cb?.failures || 0) + 1,
      opened_at: Date.now(),
      threshold: 5,
      half_open_after_ms: 30000,
      successes_after_half_open: 2
    });
    this.triggerAlert('circuit_trip', { nodeId, modelKey, key });
  }

  untripCircuitBreaker(nodeId, modelKey) {
    const key = `${nodeId}:${modelKey || '*'}`;
    const cb = this.circuitBreakers.get(key);
    if (cb && cb.state === 'half-open') {
      cb.successes++;
      if (cb.successes >= cb.successes_after_half_open) {
        cb.state = 'closed';
        cb.failures = 0;
        cb.successes = 0;
      }
    } else if (cb) {
      cb.state = 'closed';
      cb.failures = 0;
    }
  }

  getCircuitBreakerSummary() {
    const summary = [];
    for (const [key, cb] of this.circuitBreakers) {
      summary.push({ key, state: cb.state, failures: cb.failures });
    }
    return summary;
  }

  setCircuitBreakerState(nodeId, modelKey, state) {
    const key = `${nodeId}:${modelKey || '*'}`;
    if (state === 'reset') {
      this.circuitBreakers.delete(key);
    } else {
      this.circuitBreakers.set(key, {
        state, failures: 0, opened_at: Date.now(),
        threshold: 5, half_open_after_ms: 30000, successes_after_half_open: 2
      });
    }
  }

  // ---- Rate Limiting ----

  checkRateLimit(userId, nodeId) {
    // Check per-user limits
    if (userId && this.rateLimits.perUser[userId]) {
      const rl = this.rateLimits.perUser[userId];
      // Simplified: check if would exceed any limit
      // Real implementation would use sliding windows
      if (rl.rpm > 0 && this.getUserUsage(userId).requests_this_minute >= rl.rpm) {
        return { allowed: false, reason: 'user_rpm_exceeded', limit: rl.rpm };
      }
      if (rl.rpd > 0 && this.getUserUsage(userId).requests_today >= rl.rpd) {
        return { allowed: false, reason: 'user_rpd_exceeded', limit: rl.rpd };
      }
    }

    // Check per-node limits
    if (nodeId && this.rateLimits.perNode[nodeId]) {
      const rl = this.rateLimits.perNode[nodeId];
      const node = this.nodes.get(nodeId);
      if (rl.rpm > 0 && (node?.active_tasks || 0) > rl.rpm) {
        return { allowed: false, reason: 'node_rpm_exceeded' };
      }
    }

    return { allowed: true };
  }

  getUserUsage(userId) {
    const tokens = this.quotas?.userTokensUsed.get(userId) || { monthly: 0, daily: 0, hourly: 0 };
    const reqs = { requests_today: this.quotas?.totalRequestsToday || 0, requests_this_minute: 0 };
    return { ...tokens, ...reqs };
  }

  setUserRateLimits(userId, limits) {
    this.rateLimits.perUser[userId] = limits;
    console.log(`[ORCH] Rate limits set for user ${userId}:`, limits);
  }

  setNodeRateLimits(nodeId, limits) {
    this.rateLimits.perNode[nodeId] = limits;
    console.log(`[ORCH] Rate limits set for node ${nodeId}:`, limits);
  }

  setGlobalRateLimits(limits) {
    this.rateLimits.global = { ...this.rateLimits.global, ...limits };
    console.log('[ORCH] Global rate limits updated:', limits);
  }

  // ---- Cost Tracking ----

  updateNodeCost(task, result) {
    const price = this.getUnitPrice(task.model || 'general');
    const inputCost = (result.tokens_in || 0) / 1000000 * price.input;
    const outputCost = (result.tokens_out || 0) / 1000000 * price.output;
    const totalCost = inputCost + outputCost;

    this.costs.totalCostToday = (this.costs.totalCostToday || 0) + totalCost;

    // Track per-model
    const model = task.model || 'general';
    if (!this.costs.perModel[model]) {
      this.costs.perModel[model] = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
    }
    this.costs.perModel[model].inputTokens += result.tokens_in || 0;
    this.costs.perModel[model].outputTokens += result.tokens_out || 0;
    this.costs.perModel[model].estimatedCost += totalCost;

    // Track per-provider
    if (!this.costs.perProvider['local']) {
      this.costs.perProvider['local'] = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
    }
    this.costs.perProvider['local'].inputTokens += result.tokens_in || 0;
    this.costs.perProvider['local'].outputTokens += result.tokens_out || 0;
    this.costs.perProvider['local'].estimatedCost += totalCost;
  }

  getUnitPrice(model) {
    if (this.costs.unitPrices.models[model]) return this.costs.unitPrices.models[model];
    if (this.costs.unitPrices.providers[model.split('/')[0]]) return this.costs.unitPrices.providers[model.split('/')[0]];
    return this.costs.unitPrices.defaults.general;
  }

  setUnitPrice(providerOrModel, prices) {
    this.costs.unitPrices.providers[providerOrModel] = prices;
    this.costs.unitPrices.models[providerOrModel] = prices;
  }

  // ---- Token Quotas ----

  setUserTokenQuotas(userId, quotas) {
    if (!this.quotas.perUser) this.quotas.perUser = {};
    this.quotas.perUser[userId] = quotas;
    if (!this.quotas.userTokensUsed.has(userId)) {
      this.quotas.userTokensUsed.set(userId, { monthly: 0, daily: 0, hourly: 0 });
    }
  }

  // ---- Context Window Management ----

  setContextWindow(model, maxSize) {
    if (!this.contextWindows) this.contextWindows = new Map();
    this.contextWindows.set(model, {
      max_tokens: maxSize,
      soft_limit: Math.floor(maxSize * 0.9),
      hard_limit: maxSize
    });
  }

  getContextWindow(model) {
    return this.contextWindows?.get(model) || { max_tokens: 8192, soft_limit: 7373, hard_limit: 8192 };
  }

  // ---- Request Logging ----

  logRequest(task, result) {
    const entry = {
      id: task.id,
      timestamp: Date.now(),
      type: task.type,
      model: task.model,
      status: task.status,
      assigned_node: task.assigned_to,
      latency_ms: task.status === 'completed'
        ? (task.completed_at - task.created_at)
        : (Date.now() - task.attempted_at),
      tokens_in: result?.tokens_in || 0,
      tokens_out: result?.tokens_out || 0,
      error: result?.error || task.error,
      source: task.source
    };
    this.requestLog.push(entry);
    if (this.requestLog.length > this.maxLogEntries) {
      this.requestLog.shift();
    }
  }

  getRequestLogs(options = {}) {
    const { filter, search, limit = 100, offset = 0 } = options;
    let logs = [...this.requestLog];

    if (filter?.status) logs = logs.filter(l => l.status === filter.status);
    if (filter?.type) logs = logs.filter(l => l.type === filter.type);
    if (filter?.model) logs = logs.filter(l => l.model?.includes(filter.model));
    if (filter?.node) logs = logs.filter(l => l.assigned_node === filter.node);
    if (search) logs = logs.filter(l => l.id.includes(search) || l.error?.includes(search) || '');

    return logs.slice(offset, offset + limit);
  }

  getTotalRequestCount() {
    return this.requestLog.length;
  }

  // ---- Alerts ----

  triggerAlert(type, data) {
    if (!this.alerts.enabled) return;

    // Check suppression windows
    for (const sw of this.alerts.suppressionWindows) {
      if (sw.reason === type && Date.now() < sw.until) return;
    }

    const alert = {
      id: crypto.randomUUID().slice(0, 8),
      type,
      severity: this.getAlertSeverity(type),
      data,
      timestamp: Date.now(),
      acknowledged: false,
      escalated: false
    };

    this.alerts.activeAlerts.push(alert);

    // Send to configured channels
    for (const channel of this.alerts.channels) {
      this.sendAlert(channel, alert);
    }
  }

  getAlertSeverity(type) {
    const severityMap = {
      cpu_critical: 'critical', cpu_warning: 'warning',
      mem_critical: 'critical', mem_warning: 'warning',
      node_offline: 'critical', node_stressed: 'warning',
      queue_depth_high: 'warning', queue_depth_critical: 'critical',
      circuit_trip: 'warning', error_rate_high: 'critical',
      disk_low: 'warning', disk_critical: 'critical'
    };
    return severityMap[type] || 'info';
  }

  sendAlert(channel, alert) {
    // Placeholder — implement per channel type
    console.log(`[ALERT] ${alert.severity.toUpperCase()} → ${channel}: ${alert.type} ${JSON.stringify(alert.data)}`);
  }

  acknowledgeAlert(alertId) {
    const alert = this.alerts.activeAlerts.find(a => a.id === alertId);
    if (alert) alert.acknowledged = true;
  }

  clearAlert(alertId) {
    this.alerts.activeAlerts = this.alerts.activeAlerts.filter(a => a.id !== alertId);
  }

  clearAllAlerts() {
    this.alerts.activeAlerts = [];
  }

  // ---- Background Tasks ----

  startHeartbeatMonitor() {
    setInterval(() => {
      const now = Date.now();
      for (const [, node] of this.nodes) {
        if (node.status !== 'offline' && now - node.last_heartbeat > this.config.staleThresholdMs) {
          const oldStatus = node.status;
          node.status = 'offline';
          node.offlined_at = now;
          if (oldStatus !== 'offline') {
            this.triggerAlert('node_offline', { nodeId: node.node_id, ip: node.ip });
          }
        }
      }
    }, 30000); // Check every 30s
  }

  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      // Remove expired tasks
      for (const [id, task] of this.tasks) {
        if (now - task.created_at > this.config.taskTimeoutMs && (task.status === 'running' || task.status === 'pending')) {
          this.handleTaskFailure(id, 'Task timed out');
          this.tasks.delete(id);
        }
        if (task.status === 'completed' && now - task.completed_at > 86400000) {
          this.tasks.delete(id); // Keep completed for 24h then purge
        }
      }

      // Remove old completed streams
      if (this.activeStreams) {
        for (const [id, stream] of this.activeStreams) {
          if (stream.status === 'completed' && now - stream.completed_at > 3600000) {
            this.activeStreams.delete(id);
          }
        }
      }
    }, 60000); // Every minute
  }

  startAlertChecks() {
    setInterval(() => {
      for (const [, node] of this.nodes) {
        if (node.status === 'offline') continue;

        const cpu = node.total_cpu_percent || 0;
        const mem = node.total_mem_percent || 0;

        if (cpu > this.alerts.thresholds.cpuCritical) {
          this.triggerAlert('cpu_critical', { nodeId: node.node_id, value: cpu });
        } else if (cpu > this.alerts.thresholds.cpuWarning) {
          this.triggerAlert('cpu_warning', { nodeId: node.node_id, value: cpu });
        }

        if (mem > this.alerts.thresholds.memCritical) {
          this.triggerAlert('mem_critical', { nodeId: node.node_id, value: mem });
        } else if (mem > this.alerts.thresholds.memWarning) {
          this.triggerAlert('mem_warning', { nodeId: node.node_id, value: mem });
        }
      }

      // Queue depth alerts
      const queued = this.tasks.size;
      if (queued > this.alerts.thresholds.queueDepthCritical) {
        this.triggerAlert('queue_depth_critical', { count: queued });
      } else if (queued > this.alerts.thresholds.queueDepthWarning) {
        this.triggerAlert('queue_depth_warning', { count: queued });
      }
    }, 60000); // Every minute
  }

  startHistoryRecorder() {
    setInterval(() => {
      const now = Date.now();
      for (const [, node] of this.nodes) {
        if (node.status === 'offline') continue;
        const point = {
          timestamp: now,
          cpu: node.total_cpu_percent || 0,
          mem: node.total_mem_percent || 0,
          active_jobs: node.active_tasks || 0,
          errors: 0
        };
        const hist = this.healthHistory.get(node.node_id) || [];
        hist.push(point);
        if (hist.length > this.maxHistoryPoints) hist.shift();
        this.healthHistory.set(node.node_id, hist);
      }
    }, 60000); // Record every minute
  }

  getHealthHistory(nodeId, hours = 24) {
    return this.healthHistory.get(nodeId)?.slice(-hours * 60) || [];
  }

  // ---- Config Management ----

  getConfig() {
    return { ...this.config };
  }

  setConfig(updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (key in this.config) {
        this.config[key] = value;
        console.log(`[ORCH] Config updated: ${key} = ${value}`);
      }
    }
  }

  setModelAffinity(model, nodeIds) {
    if (nodeIds.length === 0) {
      this.config.modelAffinity.delete(model);
    } else {
      this.config.modelAffinity.set(model, nodeIds);
    }
  }

  setCanaryPercent(percent) {
    this.config.canaryPercent = Math.min(100, Math.max(0, percent));
  }

  // ---- Shutdown ----

  shutdown() {
    console.log('[ORCH] Shutting down...');
    for (const [, node] of this.nodes) {
      node.status = 'draining';
    }
  }
}

module.exports = Orchestrator;
