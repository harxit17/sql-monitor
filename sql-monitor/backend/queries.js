// queries.js — All SQL Server DMV queries for monitoring

const QUERIES = {

  // ── Instance info ──────────────────────────────────────────────────────────
  instanceInfo: `
  SELECT
    SERVERPROPERTY('ServerName') AS instance_name,
    CASE 
        WHEN PARSENAME(CONVERT(varchar(50), SERVERPROPERTY('ProductVersion')), 4) = '13' THEN 'SQL Server 2016'
        WHEN PARSENAME(CONVERT(varchar(50), SERVERPROPERTY('ProductVersion')), 4) = '14' THEN 'SQL Server 2017'
        WHEN PARSENAME(CONVERT(varchar(50), SERVERPROPERTY('ProductVersion')), 4) = '15' THEN 'SQL Server 2019'
        WHEN PARSENAME(CONVERT(varchar(50), SERVERPROPERTY('ProductVersion')), 4) = '16' THEN 'SQL Server 2022'
        WHEN PARSENAME(CONVERT(varchar(50), SERVERPROPERTY('ProductVersion')), 4) = '17' THEN 'SQL Server 2025'
        ELSE 'Unknown Version'
    END AS version,
     CASE 
        WHEN @@VERSION LIKE '%KB%' 
        THEN SUBSTRING(@@VERSION, PATINDEX('%KB[0-9]%', @@VERSION), 9)
        ELSE 'KB Not Found'
    END AS update_level,
   CONCAT(
    CAST(SERVERPROPERTY('ProductLevel') AS varchar(20)),
    ' ',
    CAST(SERVERPROPERTY('ProductUpdateLevel') AS varchar(20))
    ) AS product_level,
    SERVERPROPERTY('Edition')            AS edition,
    SERVERPROPERTY('Edition')            AS engine_edition,
    SERVERPROPERTY('Collation')          AS collation,
    SERVERPROPERTY('IsClustered')        AS is_clustered,
    SERVERPROPERTY('IsHadrEnabled')      AS is_hadr_enabled,
    @@VERSION                            AS full_version_string
  `,

  // ── OS / host info via xp_cmdshell alternative (sys.dm_os_sys_info) ───────
  osInfo: `
    SELECT
      i.cpu_count                               AS logical_cpu_count,
      i.hyperthread_ratio,
      i.cpu_count / i.hyperthread_ratio         AS physical_cpu_count,
      i.physical_memory_kb / 1024               AS physical_memory_mb,
      i.sqlserver_start_time                    AS sql_start_time,
      h.host_platform,
      h.host_distribution,
      h.host_release,
      h.host_service_pack_level,
      h.host_sku
    FROM sys.dm_os_sys_info i
    CROSS JOIN sys.dm_os_host_info h
  `,

  // ── CPU utilisation (ring buffer, last 1 min average) ─────────────────────
  cpuUsage: `
    DECLARE @ts_now BIGINT = (SELECT cpu_ticks FROM sys.dm_os_sys_info);
    SELECT TOP 5
      record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]', 'int')  AS sql_cpu_pct,
      record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]',          'int')  AS idle_pct,
      100
        - record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]',      'int')
        - record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]','int') AS other_cpu_pct,
      DATEADD(ms, -1 * ((@ts_now - [timestamp]) / (cpu_ticks_in_ms.ticks_per_ms)), GETDATE()) AS sample_time
    FROM (
      SELECT [timestamp], CONVERT(XML, record) AS record
      FROM   sys.dm_os_ring_buffers
      WHERE  ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR'
        AND  record LIKE '%<SystemHealth>%'
    ) AS ring_data
    CROSS JOIN (SELECT CAST(cpu_ticks AS FLOAT) / CAST(ms_ticks AS FLOAT) AS ticks_per_ms FROM sys.dm_os_sys_info) AS cpu_ticks_in_ms
    ORDER BY [timestamp] DESC
  `,

  // ── Memory ────────────────────────────────────────────────────────────────
  memoryUsage: `
    SELECT
      physical_memory_in_use_kb / 1024                    AS sql_memory_used_mb,
      locked_page_allocations_kb / 1024                   AS locked_pages_mb,
      page_fault_count,
      memory_utilization_percentage
    FROM sys.dm_os_process_memory;

    SELECT
      [type],
      SUM(pages_kb) / 1024 AS size_mb
    FROM sys.dm_os_memory_clerks
    GROUP BY [type]
    ORDER BY size_mb DESC;

    SELECT
      value_in_use AS max_server_memory_mb
    FROM sys.configurations
    WHERE name = 'max server memory (MB)';
  `,

  // ── Databases ─────────────────────────────────────────────────────────────
  databases: `
    SELECT
      d.database_id,
      d.name,
      d.state_desc                                        AS status,
      d.recovery_model_desc                               AS recovery_model,
      d.compatibility_level,
      d.is_read_only,
      d.is_auto_close_on,
      d.is_auto_shrink_on,
      d.log_reuse_wait_desc,
      d.create_date,
      SUM(CASE WHEN mf.type = 0 THEN mf.size * 8.0 / 1024 ELSE 0 END)  AS data_size_mb,
      SUM(CASE WHEN mf.type = 1 THEN mf.size * 8.0 / 1024 ELSE 0 END)  AS log_size_mb,
      SUM(CASE WHEN mf.type = 0
        THEN FILEPROPERTY(mf.name, 'SpaceUsed') * 8.0 / 1024
        ELSE 0 END)                                                       AS data_used_mb
    FROM sys.databases d
    LEFT JOIN sys.master_files mf ON d.database_id = mf.database_id
    GROUP BY
      d.database_id, d.name, d.state_desc, d.recovery_model_desc,
      d.compatibility_level, d.is_read_only, d.is_auto_close_on,
      d.is_auto_shrink_on, d.log_reuse_wait_desc, d.create_date
    ORDER BY d.name
  `,

  // ── Last backup per database ───────────────────────────────────────────────
  lastBackup: `
    SELECT
    database_name,
    MAX(CASE WHEN type = 'D' THEN CONVERT(varchar(19), backup_finish_date, 120) END) AS last_full,
    MAX(CASE WHEN type = 'L' THEN CONVERT(varchar(19), backup_finish_date, 120) END) AS last_log,
    MAX(CASE WHEN type = 'I' THEN CONVERT(varchar(19), backup_finish_date, 120) END) AS last_diff
    FROM msdb.dbo.backupset
    WHERE backup_finish_date >= DATEADD(DAY, -30, GETDATE())
    GROUP BY database_name;
  `,

  // ── Drive / volume space ───────────────────────────────────────────────────
  driveSpace: `
    IF OBJECT_ID('tempdb..#drives') IS NOT NULL DROP TABLE #drives;
    CREATE TABLE #drives (drive CHAR(1), free_mb INT);
    INSERT INTO #drives EXEC xp_fixeddrives;

    SELECT
      d.drive + ':\'                            AS volume_mount_point,
      d.drive + ': drive'                        AS logical_volume_name,
      'NTFS'                                     AS file_system_type,
      CAST(
        COALESCE(
          (SELECT TOP 1 CAST(mf.size * 8.0 / 1024 / 1024 AS DECIMAL(18,2))
           FROM sys.master_files mf
           WHERE mf.physical_name LIKE d.drive + ':%'
           ORDER BY mf.size DESC),
          0
        ) AS DECIMAL(18,2)
      )                                          AS total_gb,
      CAST(d.free_mb / 1024.0 AS DECIMAL(18,2)) AS free_gb,
      NULL                                       AS used_gb,
      NULL                                       AS used_pct
    FROM #drives d
    ORDER BY d.drive;

    DROP TABLE #drives;
  `,

  // ── SQL Server Agent status ────────────────────────────────────────────────
  agentJobs: `
    SELECT
      j.name                                AS job_name,
      j.enabled,
      h.run_status,                          -- 0=Failed 1=Succeeded 2=Retry 3=Cancelled 4=Running
      h.run_date,
      h.run_time,
      h.run_duration,
      h.message
    FROM msdb.dbo.sysjobs j
    LEFT JOIN msdb.dbo.sysjobhistory h
      ON  j.job_id = h.job_id
      AND h.instance_id = (
        SELECT MAX(instance_id) FROM msdb.dbo.sysjobhistory WHERE job_id = j.job_id
      )
    ORDER BY j.name
  `,

  // ── Active connections / sessions ─────────────────────────────────────────
  sessions: `
    SELECT
      COUNT(*)                              AS total_sessions,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END)   AS active,
      SUM(CASE WHEN status = 'sleeping' THEN 1 ELSE 0 END)  AS sleeping,
      SUM(CASE WHEN is_user_process = 1 THEN 1 ELSE 0 END)  AS user_sessions,
      SUM(CASE WHEN is_user_process = 0 THEN 1 ELSE 0 END)  AS system_sessions
    FROM sys.dm_exec_sessions
    WHERE session_id > 0
  `,

  // ── AOAG / HADR status ───────────────────────────────────────────────────
  aoagStatus: `
    IF SERVERPROPERTY('IsHadrEnabled') = 1
    BEGIN
      -- Availability Group overview
      SELECT
        ag.name                               AS ag_name,
        ag.automated_backup_preference_desc   AS backup_preference,
        ag.failure_condition_level,
        ags.primary_replica,
        ags.synchronization_health_desc       AS ag_health,
        CASE WHEN ags.primary_replica = SERVERPROPERTY('ServerName')
             THEN 'PRIMARY' ELSE 'SECONDARY' END AS local_role
      FROM sys.availability_groups ag
      JOIN sys.dm_hadr_availability_group_states ags
        ON ag.group_id = ags.group_id

      -- Replica details
      SELECT
        ag.name                               AS ag_name,
        ar.replica_server_name,
        ar.availability_mode_desc             AS availability_mode,
        ar.failover_mode_desc                 AS failover_mode,
        ar.endpoint_url,
        ars.role_desc                         AS role,
        ars.operational_state_desc            AS operational_state,
        ars.connected_state_desc              AS connected_state,
        ars.synchronization_health_desc       AS sync_health,
        ars.last_connect_error_number,
        ars.last_connect_error_description,
        ars.last_connect_error_timestamp
      FROM sys.availability_groups ag
      JOIN sys.availability_replicas ar ON ag.group_id = ar.group_id
      JOIN sys.dm_hadr_availability_replica_states ars ON ar.replica_id = ars.replica_id
      ORDER BY ag.name, ars.role_desc

      -- Database replica details
      SELECT
        ag.name                               AS ag_name,
        db_name(drs.database_id)              AS database_name,
        ar.replica_server_name,
        drs.synchronization_state_desc        AS sync_state,
        drs.synchronization_health_desc       AS sync_health,
        drs.database_state_desc               AS db_state,
        drs.is_suspended,
        drs.suspend_reason_desc,
        drs.log_send_queue_size,
        drs.log_send_rate,
        drs.redo_queue_size,
        drs.redo_rate,
        drs.secondary_lag_seconds
      FROM sys.dm_hadr_database_replica_states drs
      JOIN sys.availability_replicas ar ON drs.replica_id = ar.replica_id
      JOIN sys.availability_groups ag ON ar.group_id = ag.group_id
      ORDER BY ag.name, db_name(drs.database_id), ar.replica_server_name

      -- Listener details
      SELECT
        ag.name                               AS ag_name,
        agl.dns_name                          AS listener_dns,
        agl.port                              AS listener_port,
        ip.ip_address,
        ip.ip_subnet_mask,
        ip.state_desc                         AS ip_state
      FROM sys.availability_groups ag
      JOIN sys.availability_group_listeners agl ON ag.group_id = agl.group_id
      JOIN sys.availability_group_listener_ip_addresses ip ON agl.listener_id = ip.listener_id
    END
    ELSE
    BEGIN
      SELECT 'HADR_NOT_ENABLED' AS ag_name, NULL AS backup_preference,
             NULL AS failure_condition_level, NULL AS primary_replica,
             NULL AS ag_health, NULL AS ag_state, NULL AS local_role
      WHERE 1=0
    END
  `,

  // ── Service status ───────────────────────────────────────────────────────
  serviceStatus: `
    SELECT
      servicename,
      status_desc,
      startup_type_desc,
      service_account,
      last_startup_time
    FROM sys.dm_server_services
  `,

  // ── Long running queries ─────────────────────────────────────────────────
  longRunningQueries: `
    SELECT TOP 20
      r.session_id,
      r.status,
      r.blocking_session_id,
      r.wait_type,
      r.wait_time                                         AS wait_time_ms,
      r.cpu_time                                          AS cpu_time_ms,
      r.total_elapsed_time                                AS elapsed_ms,
      r.logical_reads,
      r.reads,
      r.writes,
      DB_NAME(r.database_id)                              AS database_name,
      s.login_name,
      s.host_name,
      s.program_name,
      SUBSTRING(qt.text, (r.statement_start_offset/2)+1,
        ((CASE r.statement_end_offset
          WHEN -1 THEN DATALENGTH(qt.text)
          ELSE r.statement_end_offset
         END - r.statement_start_offset)/2)+1)            AS query_text,
      qp.query_plan
    FROM sys.dm_exec_requests r
    JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) qt
    CROSS APPLY sys.dm_exec_query_plan(r.plan_handle) qp
    WHERE r.session_id <> @@SPID
      AND s.is_user_process = 1
      AND r.total_elapsed_time > 5000
    ORDER BY r.total_elapsed_time DESC
  `,

  // ── SQL Error Log ─────────────────────────────────────────────────────────
  errorLog: `
    DECLARE @since DATETIME = DATEADD(HOUR, -2, GETDATE());
    IF OBJECT_ID('tempdb..#errorlog') IS NOT NULL DROP TABLE #errorlog;
    CREATE TABLE #errorlog (
      log_date     DATETIME,
      process_info VARCHAR(100),
      log_text     VARCHAR(MAX)
    );
    INSERT INTO #errorlog EXEC xp_readerrorlog 0, 1, NULL, NULL, @since, NULL, 'DESC';
    SELECT
      CONVERT(VARCHAR(19), log_date, 120)  AS log_date,
      process_info,
      log_text,
      CASE
        WHEN log_text LIKE '%error%'        THEN 'ERROR'
        WHEN log_text LIKE '%fail%'         THEN 'ERROR'
        WHEN log_text LIKE '%corrupt%'      THEN 'ERROR'
        WHEN log_text LIKE '%fatal%'        THEN 'ERROR'
        WHEN log_text LIKE '%severity%'     THEN 'ERROR'
        ELSE 'ERROR'
      END                                   AS severity
    FROM #errorlog
    WHERE log_date >= @since
      AND (
        log_text LIKE '%error%'
        OR log_text LIKE '%fail%'
        OR log_text LIKE '%corrupt%'
        OR log_text LIKE '%fatal%'
        OR log_text LIKE '%severity%'
        OR log_text LIKE '%Login failed%'
      )
      AND log_text NOT LIKE '%DBCC TRACEON%'
      AND log_text NOT LIKE '%This is an informational message%'
      AND log_text NOT LIKE '%Log was backed up%'
      AND log_text NOT LIKE '%found 0 errors%'
      AND log_text NOT LIKE '%without errors%'
    ORDER BY log_date DESC;
    DROP TABLE #errorlog;
  `,

  // ── Index health ──────────────────────────────────────────────────────────
  indexHealth: `
    SELECT TOP 50
      DB_NAME()                                           AS database_name,
      OBJECT_NAME(s.object_id)                            AS table_name,
      i.name                                              AS index_name,
      i.type_desc                                         AS index_type,
      s.index_id,
      CAST(s.avg_fragmentation_in_percent AS DECIMAL(5,1)) AS fragmentation_pct,
      s.page_count,
      s.avg_page_space_used_in_percent,
      CASE
        WHEN s.avg_fragmentation_in_percent >= 30 THEN 'REBUILD'
        WHEN s.avg_fragmentation_in_percent >= 10 THEN 'REORGANIZE'
        ELSE 'OK'
      END                                                 AS recommended_action
    FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') s
    JOIN sys.indexes i ON s.object_id = i.object_id AND s.index_id = i.index_id
    WHERE s.page_count > 100
      AND i.name IS NOT NULL
      AND s.avg_fragmentation_in_percent > 5
    ORDER BY s.avg_fragmentation_in_percent DESC
  `,

  // ── Drive space from Agent job dump table ─────────────────────────────────
  driveSpaceMonitor: `
    SELECT
      server_name,
      drive_letter,
      drive_label,
      total_gb,
      free_gb,
      used_gb,
      used_pct,
      CONVERT(VARCHAR(19), collected_at, 120) AS collected_at
    FROM tempdb.dbo.drive_space_monitor
    ORDER BY server_name, drive_letter
  `,

  // ── Top waits (last snapshot) ──────────────────────────────────────────────
  topWaits: `
    SELECT TOP 10
      wait_type,
      waiting_tasks_count,
      wait_time_ms,
      max_wait_time_ms,
      signal_wait_time_ms
    FROM sys.dm_os_wait_stats
    WHERE wait_type NOT IN (
      'SLEEP_TASK','BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_AUTO_EVENT',
      'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT',
      'HADR_FILESTREAM_IOMGR_IOCOMPLETION','HADR_WORK_QUEUE','LAZYWRITER_SLEEP',
      'LOGMGR_QUEUE','ONDEMAND_TASK_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH',
      'RESOURCE_QUEUE','SERVER_IDLE_CHECK','SLEEP_DBSTARTUP','SLEEP_DCOMSTARTUP',
      'SLEEP_MASTERDBREADY','SLEEP_MASTERMDREADY','SLEEP_MASTERUPGRADED',
      'SLEEP_MSDBSTARTUP','SLEEP_SYSTEMTASK','SLEEP_TEMPDBSTARTUP',
      'SNI_HTTP_ACCEPT','SP_SERVER_DIAGNOSTICS_SLEEP','SQLTRACE_BUFFER_FLUSH',
      'SQLTRACE_INCREMENTAL_FLUSH_SLEEP','WAITFOR','XE_DISPATCHER_WAIT',
      'XE_TIMER_EVENT','BROKER_EVENTHANDLER','CHECKPOINT_QUEUE',
      'DBMIRROR_EVENTS_QUEUE','SQLTRACE_WAIT_ENTRIES','WAIT_XTP_OFFLINE_CKPT_NEW_LOG'
    )
    AND waiting_tasks_count > 0
    ORDER BY wait_time_ms DESC
  `
};

module.exports = QUERIES;
