// server.js — SQL Server Monitoring API
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const sql     = require('mssql');
const path    = require('path');
const QUERIES = require('./queries');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Serve frontend static files ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ── Parse server list from env ─────────────────────────────────────────────
const SERVER_CONFIGS = JSON.parse(process.env.SQL_SERVERS || '[]');

// Connection pool cache  { serverId -> mssql.ConnectionPool }
const pools = {};

async function getPool(serverCfg) {
  if (pools[serverCfg.id] && pools[serverCfg.id].connected) {
    return pools[serverCfg.id];
  }
  const config = {
    server:   serverCfg.server,
    database: serverCfg.database || 'master',
    port:     serverCfg.port     || 1433,
    options: {
      encrypt:                serverCfg.encrypt               ?? false,
      trustServerCertificate: serverCfg.trustServerCertificate ?? true,
      enableArithAbort:       true,
    },
    connectionTimeout: 8000,
    requestTimeout:    15000,
  };
  if (serverCfg.trustedConnection) {
    config.options.trustedConnection = true;
  } else {
    config.user     = serverCfg.user;
    config.password = serverCfg.password;
  }
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  pools[serverCfg.id] = pool;
  return pool;
}

// ── Helper: run query safely ───────────────────────────────────────────────
async function runQuery(pool, query) {
  const result = await pool.request().query(query);
  return result.recordsets;
}

// ── GET /api/servers — list of configured servers ─────────────────────────
app.get('/api/servers', (req, res) => {
  res.json(SERVER_CONFIGS.map(s => ({ id: s.id, label: s.label, server: s.server })));
});

// ── GET /api/fleet — summary row per server (for fleet grid) ──────────────
app.get('/api/fleet', async (req, res) => {
  const results = await Promise.all(
    SERVER_CONFIGS.map(async (cfg) => {
      const base = { id: cfg.id, label: cfg.label, server: cfg.server, group: cfg.group || 'Ungrouped', subgroup: cfg.subgroup || 'Ungrouped' };
      try {
        const pool = await getPool(cfg);

        // Run lightweight summary queries in parallel
        const [instRS, osRS, cpuRS, memRS, dbRS, sessRS, driveRS] = await Promise.all([
          runQuery(pool, QUERIES.instanceInfo),
          runQuery(pool, QUERIES.osInfo),
          runQuery(pool, QUERIES.cpuUsage),
          runQuery(pool, QUERIES.memoryUsage),
          runQuery(pool, QUERIES.databases),
          runQuery(pool, QUERIES.sessions),
          runQuery(pool, QUERIES.driveSpace),
        ]);

        const inst    = instRS[0]?.[0]  || {};
        const os      = osRS[0]?.[0]    || {};
        const cpuRows = cpuRS[0]         || [];
        const memProc = memRS[0]?.[0]   || {};
        const maxMem  = memRS[2]?.[0]   || {};
        const dbs     = dbRS[0]          || [];
        const sess    = sessRS[0]?.[0]  || {};
        const drives  = driveRS[0]       || [];

        // Average CPU over last 5 samples
        const avgCpu = cpuRows.length
          ? Math.round(cpuRows.reduce((a, r) => a + (r.sql_cpu_pct || 0), 0) / cpuRows.length)
          : 0;

        const memUsedMb  = memProc.sql_memory_used_mb || 0;
        const memTotalMb = os.physical_memory_mb       || 1;
        const memPct     = Math.round((memUsedMb / memTotalMb) * 100);

        const dbOnline   = dbs.filter(d => d.status === 'ONLINE').length;
        const dbOffline  = dbs.filter(d => d.status !== 'ONLINE').length;

        // Critical drive: highest used_pct
        const critDrive = drives.reduce((a, d) => (d.used_pct > (a?.used_pct || 0) ? d : a), null);

        // Overall health: error if any service down / db offline, warn if high utilisation
        let health = 'ok';
        if (dbOffline > 0) health = 'warn';
        if (avgCpu >= 90 || memPct >= 90 || (critDrive && critDrive.used_pct >= 90)) health = 'warn';
        if (dbs.some(d => d.status === 'SUSPECT' || d.status === 'EMERGENCY')) health = 'error';

        return {
          ...base,
          status: 'online',
          health,
          version:   inst.version,
          edition:   inst.edition,
          full_version: inst.full_version_string,
          sql_start_time: os.sql_start_time,
          logical_cpus:  os.logical_cpu_count,
          physical_cpus: os.physical_cpu_count,
          cpu_pct:  avgCpu,
          mem_used_mb:   memUsedMb,
          mem_total_mb:  memTotalMb,
          mem_pct:       memPct,
          max_server_mem_mb: maxMem.max_server_memory_mb,
          db_total:   dbs.length,
          db_online:  dbOnline,
          db_offline: dbOffline,
          sessions:       sess.total_sessions || 0,
          active_sessions: sess.active        || 0,
          drives,
          crit_drive: critDrive,
          hadr_enabled: inst.is_hadr_enabled == 1,
        };
      } catch (err) {
        return {
          ...base,
          status: 'offline',
          health: 'error',
          error: err.message,
        };
      }
    })
  );
  res.json(results);
});

// ── GET /api/server/:id — full detail for one server ──────────────────────
app.get('/api/server/:id', async (req, res) => {
  const cfg = SERVER_CONFIGS.find(s => s.id === req.params.id);
  if (!cfg) return res.status(404).json({ error: 'Server not found' });

  try {
    const pool = await getPool(cfg);

    const [instRS, osRS, cpuRS, memRS, dbRS, backupRS, driveRS, sessRS, waitRS, agentRS, aoagRS, svcRS, lrqRS, errRS, idxRS] =
      await Promise.all([
        runQuery(pool, QUERIES.instanceInfo),
        runQuery(pool, QUERIES.osInfo),
        runQuery(pool, QUERIES.cpuUsage),
        runQuery(pool, QUERIES.memoryUsage),
        runQuery(pool, QUERIES.databases),
        runQuery(pool, QUERIES.lastBackup),
        runQuery(pool, QUERIES.driveSpace).catch(() => [[]]),
        runQuery(pool, QUERIES.sessions),
        runQuery(pool, QUERIES.topWaits),
        runQuery(pool, QUERIES.agentJobs).catch(() => [[]]),
        runQuery(pool, QUERIES.aoagStatus).catch(() => [[]]),
        runQuery(pool, QUERIES.serviceStatus).catch(() => [[]]),
        runQuery(pool, QUERIES.longRunningQueries).catch(() => [[]]),
        runQuery(pool, QUERIES.errorLog).catch(() => [[]]),
        runQuery(pool, QUERIES.indexHealth).catch(() => [[]]),
      ]);

    const inst      = instRS[0]?.[0]  || {};
    const os        = osRS[0]?.[0]    || {};
    const cpuRows   = cpuRS[0]         || [];
    const memProc   = memRS[0]?.[0]   || {};
    const memClerks = memRS[1]         || [];
    const maxMem    = memRS[2]?.[0]   || {};
    const dbs       = dbRS[0]          || [];
    const backups   = backupRS[0]      || [];
    const drives    = driveRS[0]       || [];
    const sess      = sessRS[0]?.[0]  || {};
    const waits     = waitRS[0]        || [];
    const jobs      = agentRS[0]       || [];

    const services    = svcRS[0] || [];
    const longQueries = lrqRS[0] || [];
    const errorLog    = errRS[0] || [];
    const indexHealth = idxRS[0] || [];

    // AOAG — 4 recordsets: ag overview, replicas, db replicas, listeners
    const aoagGroups    = aoagRS[0] || [];
    const aoagReplicas  = aoagRS[1] || [];
    const aoagDatabases = aoagRS[2] || [];
    const aoagListeners = aoagRS[3] || [];
    const hadrEnabled   = inst.is_hadr_enabled == 1;

    // Merge backup info into databases
    const backupMap = {};
    backups.forEach(b => { backupMap[b.database_name] = b; });
    const dbsWithBackup = dbs.map(d => ({
      ...d,
      last_full: backupMap[d.name]?.last_full || null,
      last_log:  backupMap[d.name]?.last_log  || null,
      last_diff: backupMap[d.name]?.last_diff || null,
    }));

    const avgCpu = cpuRows.length
      ? Math.round(cpuRows.reduce((a, r) => a + (r.sql_cpu_pct || 0), 0) / cpuRows.length)
      : 0;

    res.json({
      id:       cfg.id,
      label:    cfg.label,
      status:   'online',
      instance: inst,
      os,
      cpu: {
        samples: cpuRows,
        avg_pct: avgCpu,
      },
      memory: {
        process: memProc,
        clerks:  memClerks.slice(0, 10),
        max_server_mem_mb: maxMem.max_server_memory_mb,
      },
      databases: dbsWithBackup,
      drives,
      sessions: sess,
      waits,
      jobs,
      hadr: {
        enabled:   hadrEnabled,
        groups:    aoagGroups,
        replicas:  aoagReplicas,
        databases: aoagDatabases,
        listeners: aoagListeners,
      },
      services,
      longQueries,
      errorLog,
      indexHealth,
    });

  } catch (err) {
    res.status(500).json({
      id:     cfg.id,
      label:  cfg.label,
      status: 'offline',
      error:  err.message,
    });
  }
});

// ── GET /api/server/:id/databases — databases only (lightweight refresh) ───
app.get('/api/server/:id/databases', async (req, res) => {
  const cfg = SERVER_CONFIGS.find(s => s.id === req.params.id);
  if (!cfg) return res.status(404).json({ error: 'Server not found' });
  try {
    const pool = await getPool(cfg);
    const [dbRS, backupRS] = await Promise.all([
      runQuery(pool, QUERIES.databases),
      runQuery(pool, QUERIES.lastBackup),
    ]);
    const backupMap = {};
    (backupRS[0] || []).forEach(b => { backupMap[b.database_name] = b; });
    const result = (dbRS[0] || []).map(d => ({
      ...d,
      last_full: backupMap[d.name]?.last_full || null,
      last_log:  backupMap[d.name]?.last_log  || null,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/drivespace — drive space from all servers via tempdb table ───
app.get('/api/drivespace', async (req, res) => {
  const results = await Promise.all(
    SERVER_CONFIGS.map(async (cfg) => {
      try {
        const pool = await getPool(cfg);
        const [rs] = await runQuery(pool, QUERIES.driveSpaceMonitor);
        return { id: cfg.id, label: cfg.label, group: cfg.group || 'Ungrouped', status: 'ok', drives: rs || [] };
      } catch (err) {
        return { id: cfg.id, label: cfg.label, group: cfg.group || 'Ungrouped', status: 'error', drives: [], error: err.message };
      }
    })
  );
  const flat = results.flatMap(r =>
    r.drives.map(d => ({ ...d, server_id: r.id, server_label: r.label }))
  );
  res.json({ servers: results, drives: flat });
});

// ── GET /api/config — expose safe client config ───────────────────────────
app.get('/api/config', (req, res) => {
  const groups = {};
  SERVER_CONFIGS.forEach(s => { groups[s.id] = s.group || 'Ungrouped'; });
  res.json({ serverGroups: groups });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\nClosing connection pools...');
  await Promise.all(Object.values(pools).map(p => p.close()));
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`SQL Monitor API running on http://localhost:${PORT}`);
  console.log(`Monitoring ${SERVER_CONFIGS.length} server(s)`);
});
