# SQL Server Monitor

Dark terminal-style fleet monitoring dashboard.  
Direct SQL queries via Node.js/Express + `mssql` 


### Requirements
```
1- Linux server [(Ubuntu 20.04+ or RHEL) (I have tested/run this on wsl)] 
2- Node.js 18+ 
3- Network access to your SQL instances on port 1433 
4- A user account (don't run as root)
```
### Install Node.js
```
sudo apt-get install -y nodejs
# Verify
node --version
npm --version
```
### Clone this repo
```
git clone https://github.com/harxit17/sql-monitor.git /mnt/c/sqlmonitor
```
### Install dependencies
```
cd /mnt/c/sqlmonitor/backend
npm install express cors mssql dotenv
```

### Configure your sql servers
Edit `.env` — add one JSON entry per SQL Server instance:

```json
SQL_SERVERS='[
  {
    "id":     "prod-01",
    "label":  "SQL-PROD-01",
    "server": "SQL-PROD-01",
    "user":   "monitor_user",
    "password": "YourPass",
    "database": "master",
    "port":   1433,
    "encrypt": false,
    "trustServerCertificate": true
  }
]'
```  
For named instances: `"server": "HOSTNAME\\INSTANCENAME"`.

### Start the API

```bash
cd /mnt/c/sql-monitor/backend
npm start
```

### Open the dashboard
open browser and run --> 'http://localhost:3001/'
---

### SQL Permissions Required
Create a dedicated monitoring login. Minimum required:
-- Create login and add the user to master and msdb db as readonly
```
USE [master]
GO
CREATE LOGIN [monitor_user] WITH PASSWORD=N'YourPasswordHere', DEFAULT_DATABASE=[master], DEFAULT_LANGUAGE=[us_english], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF
GO
GRANT VIEW ANY DEFINITION TO [monitor_user];
GRANT VIEW SERVER STATE TO [monitor_user];
GRANT EXECUTE ON xp_readerrorlog TO [monitor_user];
```
### File Structure
```
sql-monitor/
├── backend/
│   ├── server.js        ← Express API
│   ├── queries.js       ← All DMV SQL queries
│   ├── package.json
│   └── .env.example     ← Copy to .env and configure
└── frontend/
    └── index.html       ← Self-contained dashboard (no build step)
```
