#!/bin/bash
cd /var/www/vhosts/hivv.org/api
export HIVV_DB_PASSWORD="REDACTED_DEFAULT_DB_PASSWORD"
exec node server.js
