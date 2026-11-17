#!/bin/bash
echo "============================================"
echo "  HIVV.org — Distributed AI Control Panel"
echo "============================================"
echo ""
echo "  Dashboard : http://$(hostname -I | awk '{print $1}'):3011/control.html"
echo ""
pm2 status 2>/dev/null || echo "PM2 not running"
echo ""
curl -s http://localhost:3011/api/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "Gateway not responding"
echo ""
curl -s http://localhost:3011/api/nodes/register 2>/dev/null | head -c 200; echo
echo ""
curl -s http://localhost:3011/api/control/metrics/global 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "Orchestrator not available"
echo ""
curl -s http://localhost:3011/api/control/health 2>/dev/null | python3 -m json.tool 2>/dev/null || true
