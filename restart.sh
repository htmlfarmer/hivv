#!/bin/bash
# HIVV.org - Quick Restart
cd "$(dirname "$0")/api"
pm2 restart hivv-ai-gateway && pm2 logs hivv-ai-gateway --lines 20 --nostream
