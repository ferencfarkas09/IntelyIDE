// Demo repository fb-infra: the infrastructure code of the fictional Fernbank Cycles (Terraform modules, YAML manifests).
// Everything here is invented, including the "cloudgrid" provider. File contents are template strings so that
// tooling does not treat them as project source. Schema and rules: scripts/demo-workspace/README.md.
//
// Story: the checked-out branch chore/bump-postgres is level with origin but origin has one more commit (a pull is
// waiting). The work tree holds a multi-hunk Terraform change, a YAML change and one staged value. Tickets: FB-240
// (the bump), FB-248 and FB-214 (the refund work of fb-api, rolled out here).

/** Template literal helper: drops the first newline so every file reads naturally in this source. */
const t = (s) => s[0].replace(/^\n/, "");

/** Replaces `from` by `to` exactly once and fails loudly when the anchor is missing (keeps versions in sync). */
const edit = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error("fb-infra: edit anchor must occur exactly once: " + from.slice(0, 48));
  return text.replace(from, () => to);
};

// ---------------------------------------------------------------------------------------------------- tooling
const gitignore = t`
.terraform
*.tfstate
*.tfstate.backup
crash.log
.DS_Store
`;
const readme = t`
# fb-infra

Infrastructure for Fernbank Cycles: Terraform modules for the network, the database, the cache and the API service,
two environments (staging, production) and the Kubernetes-style manifests that the deploy job applies.

## Layout

    modules/       reusable building blocks
    environments/  one directory per environment
    deploy/        application manifests
    ops/           alert rules

Plan an environment with scripts/plan.sh staging. Nothing is applied from a laptop.
`;
const makefile = (version) =>
  "VERSION := " + version + "\n\n.PHONY: fmt validate plan\n\nfmt:\n\tterraform fmt -recursive\n\nvalidate:\n\tcd environments/staging && terraform init -backend=false && terraform validate\n\nplan:\n\tscripts/plan.sh staging\n";
const tflint = t`
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

rule "terraform_naming_convention" {
  enabled = true
}
`;
const planScript = t`
#!/bin/sh
# Prints a plan for one environment without applying anything.
set -eu

env_name="$1"
[ -d "environments/$env_name" ] || { echo "unknown environment: $env_name" >&2; exit 2; }

cd "environments/$env_name"
terraform init -backend=false -input=false
terraform plan -input=false -lock=false
`;
const planCi = t`
name: plan
trigger:
  paths:
    - environments/**
    - modules/**
jobs:
  - name: plan-staging
    image: registry.fernbank.example/platform/terraform:1.8
    script:
      - scripts/plan.sh staging
`;

// ---------------------------------------------------------------------------------------------------- modules
/** variable blocks from [name, type, default?] triples (default is the literal HCL text). */
const variables = (list) =>
  list
    .map(([name, type, def]) => 'variable "' + name + '" {\n  type' + (def === undefined ? " " : "    ") + "= " + type + "\n" + (def === undefined ? "" : "  default = " + def + "\n") + "}\n")
    .join("\n");

const networkMain = t`
resource "cloudgrid_network" "main" {
  name       = var.name
  cidr_block = var.cidr_block
  tags       = var.tags
}

resource "cloudgrid_subnet" "private" {
  count      = length(var.private_cidrs)
  network_id = cloudgrid_network.main.id
  cidr_block = var.private_cidrs[count.index]
  public     = false
}

resource "cloudgrid_subnet" "public" {
  count      = length(var.public_cidrs)
  network_id = cloudgrid_network.main.id
  cidr_block = var.public_cidrs[count.index]
  public     = true
}
`;
const networkVars = variables([["name", "string"], ["cidr_block", "string"], ["private_cidrs", "list(string)"], ["public_cidrs", "list(string)", "[]"], ["tags", "map(string)", "{}"]]);
const networkOut1 = t`
output "network_id" {
  value = cloudgrid_network.main.id
}

output "private_subnet_ids" {
  value = cloudgrid_subnet.private[*].id
}
`;
const networkOut2 = networkOut1 + t`

output "public_subnet_ids" {
  value = cloudgrid_subnet.public[*].id
}
`;

const dbMain0 = t`
resource "cloudgrid_postgres" "main" {
  name           = format("%s-pg", var.name)
  engine_version = "15.6"
  instance_class = var.instance_class
  storage_gb     = var.storage_gb
  network_id     = var.network_id
  subnet_ids     = var.private_subnet_ids

  backup_retention_days = 3
  backup_window         = "02:00-03:00"
  maintenance_window    = "sun:04:00-sun:05:00"

  parameters = {
    max_connections            = "100"
    log_min_duration_statement = "500"
  }

  tags = var.tags
}

resource "cloudgrid_postgres_replica" "read" {
  count          = var.replica_count
  source_id      = cloudgrid_postgres.main.id
  instance_class = var.instance_class
}

resource "cloudgrid_database" "app" {
  server_id = cloudgrid_postgres.main.id
  name      = "fernbank"
  owner     = "fernbank_app"
}
`;
const dbMain1 = edit(dbMain0, 'engine_version = "15.6"', 'engine_version = "16.2"');
const dbMain2 = edit(dbMain1, 'max_connections            = "100"', 'max_connections            = "200"');
const dbMain3 = edit(dbMain2, "backup_retention_days = 3", "backup_retention_days = 7");
const DB_BEFORE = '    max_connections            = "200"\n';
const DB_AFTER = '    max_connections            = "300"\n';
const dbMainFinal =
  edit(edit(dbMain3, 'engine_version = "16.2"', 'engine_version = "16.4"'), DB_BEFORE, DB_AFTER) +
  t`

resource "cloudgrid_alarm" "connections" {
  name      = format("%s-pg-connections", var.name)
  target_id = cloudgrid_postgres.main.id
  metric    = "connections"
  threshold = 250
}
`;
const dbVars = variables([["name", "string"], ["network_id", "string"], ["private_subnet_ids", "list(string)"], ["instance_class", "string", '"standard-2"'], ["storage_gb", "number", "100"], ["replica_count", "number", "0"], ["tags", "map(string)", "{}"]]);
const dbOut = t`
output "endpoint" {
  description = "Connection endpoint of the primary server."
  value       = cloudgrid_postgres.main.endpoint
}

output "database_name" {
  description = "Name of the application database."
  value       = cloudgrid_database.app.name
}
`;

const apiMain = t`
resource "cloudgrid_service" "api" {
  name     = var.name
  image    = var.image
  replicas = var.replicas
  port     = 8080

  env = {
    DATABASE_HOST = var.database_endpoint
    NODE_ENV      = "production"
  }

  health_check_path = "/healthz"
}
`;
const apiVars = variables([["name", "string"], ["image", "string", '"registry.fernbank.example/platform/fb-api:1.8.0"'], ["replicas", "number", "2"], ["database_endpoint", "string"]]);
const apiOut = t`
output "service_url" {
  description = "Public URL of the service."
  value       = cloudgrid_service.api.url
}

output "service_id" {
  description = "Identifier of the service."
  value       = cloudgrid_service.api.id
}
`;

const cacheMain = t`
resource "cloudgrid_cache" "main" {
  name        = format("%s-cache", var.name)
  memory_mb   = var.memory_mb
  network_id  = var.network_id
  subnet_ids  = var.private_subnet_ids
  eviction    = "allkeys-lru"
  tags        = var.tags
}
`;
const cacheVars = variables([["name", "string"], ["network_id", "string"], ["private_subnet_ids", "list(string)"], ["memory_mb", "number", "512"], ["tags", "map(string)", "{}"]]);
const cacheOut = t`
output "endpoint" {
  description = "Connection endpoint of the cache."
  value       = cloudgrid_cache.main.endpoint
}

output "memory_mb" {
  description = "Memory size in megabytes."
  value       = cloudgrid_cache.main.memory_mb
}
`;

// ---------------------------------------------------------------------------------------------------- environments
const versionsTf = t`
terraform {
  required_version = ">= 1.8.0"

  required_providers {
    cloudgrid = {
      source  = "registry.example/fernbank/cloudgrid"
      version = "~> 2.4"
    }
  }
}

provider "cloudgrid" {
  region = var.region
}
`;
const envVars = variables([["region", "string"], ["db_instance", "string", '"standard-2"'], ["api_replicas", "number", "2"]]);
const envMain = (name, cidr, extra) =>
  [
    'module "network" {',
    '  source        = "../../modules/network"',
    '  name          = "' + name + '"',
    '  cidr_block    = "' + cidr + '.0.0/16"',
    '  private_cidrs = ["' + cidr + '.1.0/24", "' + cidr + '.2.0/24"]',
    '  public_cidrs  = ["' + cidr + '.101.0/24"]',
    "}",
    "",
    'module "database" {',
    '  source             = "../../modules/database"',
    '  name               = "' + name + '"',
    "  network_id         = module.network.network_id",
    "  private_subnet_ids = module.network.private_subnet_ids",
    "  instance_class     = var.db_instance",
    "}",
    "",
    'module "api" {',
    '  source            = "../../modules/api-service"',
    '  name              = "fb-api"',
    "  replicas          = var.api_replicas",
    "  database_endpoint = module.database.endpoint",
    "}",
    "",
    ...extra,
  ]
    .join("\n")
    .replace(/\n*$/, "\n");
const cacheModule = ['module "cache" {', '  source             = "../../modules/cache"', '  name               = "fb-production"', "  network_id         = module.network.network_id", "  private_subnet_ids = module.network.private_subnet_ids", "}"];
const stagingMain = envMain("fb-staging", "10.20", []);
const prodMain1 = envMain("fb-production", "10.30", []);
const prodMain2 = envMain("fb-production", "10.30", cacheModule);
const stagingTfvars1 = '# Staging values. Production lives in ../production.\nregion       = "north-1"\ndb_instance  = "standard-2"\napi_replicas = 2\n';
const stagingTfvarsStaged = edit(stagingTfvars1, 'db_instance  = "standard-2"', 'db_instance  = "standard-4"');
const prodTfvars = '# Production values. Staging lives in ../staging.\nregion       = "north-1"\ndb_instance  = "standard-4"\napi_replicas = 4\n';

// ---------------------------------------------------------------------------------------------------- manifests and ops
const deployment = ({ name, image, replicas, port, env }) =>
  [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: " + name,
    "  labels:",
    "    app: " + name,
    "spec:",
    "  replicas: " + replicas,
    "  selector:",
    "    matchLabels:",
    "      app: " + name,
    "  template:",
    "    metadata:",
    "      labels:",
    "        app: " + name,
    "    spec:",
    "      containers:",
    "        - name: " + name,
    "          image: registry.fernbank.example/platform/" + image,
    "          ports:",
    "            - containerPort: " + port,
    ...(env.length ? ["          env:", ...env.flatMap(([k, v]) => ["            - name: " + k, '              value: "' + v + '"'])] : []),
    "          readinessProbe:",
    "            httpGet:",
    "              path: /healthz",
    "              port: " + port,
    "",
  ].join("\n");
const apiDeploy1 = deployment({ name: "fb-api", image: "fb-api:1.8.0", replicas: 3, port: 8080, env: [["DATABASE_POOL_SIZE", "10"]] });
const apiDeploy2 = edit(apiDeploy1, "fb-api:1.8.0", "fb-api:1.9.0");
const apiDeployFinal = edit(apiDeploy2, 'value: "10"', 'value: "20"');
const webDeploy = deployment({ name: "fb-web", image: "fb-web:2.4.0", replicas: 2, port: 8080, env: [] });
const workerDeploy = deployment({ name: "fb-worker", image: "fb-api:1.8.0", replicas: 1, port: 9090, env: [["QUEUE", "orders"]] });
const migrateJob = t`
apiVersion: batch/v1
kind: Job
metadata:
  name: fb-api-migrate
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.fernbank.example/platform/fb-api:1.9.0
          command: ["pnpm", "db:migrate"]
`;
const alertBlocks = {
  head: "groups:\n",
  api: "  - name: fb-api\n    rules:\n      - alert: ApiHighErrorRate\n        expr: rate(http_requests_failed_total[5m]) > 0.05\n        for: 10m\n        labels:\n          severity: page\n",
  db: "  - name: database\n    rules:\n      - alert: DatabaseDiskFilling\n        expr: db_disk_used_ratio > 0.85\n        for: 15m\n        labels:\n          severity: ticket\n",
  conn: "      - alert: DatabaseConnectionsHigh\n        expr: db_connections / db_connections_max > 0.8\n        for: 5m\n        labels:\n          severity: ticket\n",
  lag: "      - alert: ReplicaLag\n        expr: db_replica_lag_seconds > 30\n        for: 5m\n        labels:\n          severity: page\n",
};
const alerts1 = alertBlocks.head + alertBlocks.api + alertBlocks.db;
const alerts2 = alerts1 + alertBlocks.conn;
const alerts3 = alerts2 + alertBlocks.lag;

const runbook1 = t`
# Runbook

## Deploys

Application manifests live in deploy/. The deploy job applies them in order: migrations first, then the services.
Roll back by re-applying the previous image tag.

## Database

The database is a managed Postgres server with daily backups. Restore into a new server, never over the old one:

1. Create a server from the latest backup.
2. Point the staging API at it and run the smoke test.
3. Switch the production API over during a quiet hour.

## Alerts

Alert rules are in ops/alerts.yaml. A page means a customer is affected right now.
`;
const runbookRestore = edit(runbook1, "Restore into a new server, never over the old one:", "Restore into a new server, never over the old one (the steps below are tested every quarter):");
const runbook2 = edit(
  runbookRestore,
  "## Alerts\n",
  "## Upgrading Postgres\n\nUpgrade staging first, let it run for a week, then production. Take a manual backup before the change and check\nthe connection alarm afterwards.\n\n## Alerts\n",
);
const runbook3 = edit(runbook2, "Upgrade staging first,", "Upgrade staging first (FB-240),");

// ---------------------------------------------------------------------------------------------------- HEAD tree
const files = {
  ".gitignore": gitignore,
  "README.md": readme,
  Makefile: makefile("3.1.0"),
  ".tflint.hcl": tflint,
  "scripts/plan.sh": { text: planScript, exec: true },
  ".ci/plan.yaml": planCi,
  "docs/runbook.md": runbook2,
  "modules/network/main.tf": networkMain,
  "modules/network/variables.tf": networkVars,
  "modules/network/outputs.tf": networkOut2,
  "modules/database/main.tf": dbMain3,
  "modules/database/variables.tf": dbVars,
  "modules/database/outputs.tf": dbOut,
  "modules/api-service/main.tf": apiMain,
  "modules/api-service/variables.tf": apiVars,
  "modules/api-service/outputs.tf": apiOut,
  "modules/cache/main.tf": cacheMain,
  "modules/cache/variables.tf": cacheVars,
  "modules/cache/outputs.tf": cacheOut,
  "environments/staging/versions.tf": versionsTf,
  "environments/staging/main.tf": stagingMain,
  "environments/staging/variables.tf": envVars,
  "environments/staging/terraform.tfvars": stagingTfvars1,
  "environments/production/versions.tf": versionsTf,
  "environments/production/main.tf": prodMain2,
  "environments/production/variables.tf": envVars,
  "environments/production/terraform.tfvars": prodTfvars,
  "deploy/api.yaml": apiDeploy2,
  "deploy/web.yaml": webDeploy,
  "deploy/worker.yaml": workerDeploy,
  "deploy/migrate-job.yaml": migrateJob,
  "ops/alerts.yaml": alerts3,
};

// ---------------------------------------------------------------------------------------------------- history
const step = (at, author, message, changes, extra = {}) => ({ at, author, message, changes, ...extra });
const FEATURE = "chore/bump-postgres";

const history = [
  step("2026-08-24T09:00:00Z", "tomas", "chore: initial commit", { ".gitignore": gitignore, "README.md": readme, Makefile: makefile("3.0.0"), ".tflint.hcl": tflint }, { branch: "main" }),
  step("2026-08-25T10:00:00Z", "tomas", "feat(network): network module", { "modules/network/main.tf": networkMain, "modules/network/variables.tf": networkVars, "modules/network/outputs.tf": networkOut1 }),
  step("2026-08-26T11:00:00Z", "daniel", "feat(database): postgres module", { "modules/database/main.tf": dbMain0, "modules/database/variables.tf": dbVars, "modules/database/outputs.tf": dbOut }),
  step("2026-08-27T10:30:00Z", "daniel", "feat(api): api service module", { "modules/api-service/main.tf": apiMain, "modules/api-service/variables.tf": apiVars, "modules/api-service/outputs.tf": apiOut }),
  step("2026-08-28T09:45:00Z", "tomas", "feat(staging): staging environment", { "environments/staging/versions.tf": versionsTf, "environments/staging/main.tf": stagingMain, "environments/staging/variables.tf": envVars, "environments/staging/terraform.tfvars": stagingTfvars1 }),
  step("2026-08-29T14:15:00Z", "tomas", "feat(production): production environment", { "environments/production/versions.tf": versionsTf, "environments/production/main.tf": prodMain1, "environments/production/variables.tf": envVars, "environments/production/terraform.tfvars": prodTfvars }),
  step("2026-08-31T10:05:00Z", "daniel", "feat(deploy): api, web and worker manifests", { "deploy/api.yaml": apiDeploy1, "deploy/web.yaml": webDeploy, "deploy/worker.yaml": workerDeploy }),
  step("2026-09-01T11:20:00Z", "priya", "feat(cache): cache module", { "modules/cache/main.tf": cacheMain, "modules/cache/variables.tf": cacheVars, "modules/cache/outputs.tf": cacheOut }),
  step("2026-09-02T10:10:00Z", "priya", "feat(production): add a cache to production", { "environments/production/main.tf": prodMain2 }),
  step("2026-09-04T13:30:00Z", "daniel", "ci: plan pipeline for pull requests", { ".ci/plan.yaml": planCi, "scripts/plan.sh": { text: planScript, exec: true } }),
  step("2026-09-05T10:00:00Z", "tomas", "docs: runbook for deploys, backups and alerts", { "docs/runbook.md": runbook1 }),
  step("2026-09-07T09:30:00Z", "mira", "feat(alerts): alert rules for the api and the database", { "ops/alerts.yaml": alerts1 }),
  step("2026-09-08T15:00:00Z", "daniel", "fix(network): output the public subnet ids", { "modules/network/outputs.tf": networkOut2 }),
  step("2026-09-09T10:20:00Z", "tomas", "docs: describe how to restore a backup", { "docs/runbook.md": runbookRestore }),
  step("2026-09-10T11:00:00Z", "daniel", "feat(deploy): run the refunds migration as a job (FB-248)", { "deploy/migrate-job.yaml": migrateJob }),
  step("2026-09-11T10:30:00Z", "daniel", "chore(db): bump postgres to 16.2 in staging (FB-240)", { "modules/database/main.tf": dbMain1 }, { branch: FEATURE }),
  step("2026-09-14T09:40:00Z", "priya", "chore(deploy): roll out fb-api 1.9.0 with refunds (FB-214)", { "deploy/api.yaml": apiDeploy2 }, { branch: "main" }),
  step("2026-09-15T14:05:00Z", "daniel", "chore(db): raise max connections for the refunds worker (FB-248)", { "modules/database/main.tf": dbMain2 }, { branch: FEATURE }),
  step("2026-09-17T09:00:00Z", "release-bot", "chore(release): v3.1.0", { Makefile: makefile("3.1.0") }, { branch: "main", tag: { name: "v3.1.0", message: "Release v3.1.0" } }),
  { at: "2026-09-18T10:45:00Z", author: "tomas", message: "Merge branch 'main' into chore/bump-postgres", branch: FEATURE, merge: { from: "main", message: "Merge branch 'main' into chore/bump-postgres" } },
  step("2026-09-21T11:10:00Z", "tomas", "docs: describe the postgres upgrade steps (FB-240)", { "docs/runbook.md": runbook2 }),
  step("2026-09-23T10:25:00Z", "mira", "feat(alerts): alert when database connections run high", { "ops/alerts.yaml": alerts2 }),
  step("2026-09-24T15:30:00Z", "priya", "feat(alerts): page on replica lag", { "ops/alerts.yaml": alerts3 }),
  step("2026-09-25T10:15:00Z", "daniel", "chore(db): keep seven days of backups", { "modules/database/main.tf": dbMain3 }),
];

// One commit that exists on origin only: the pull waiting for the user.
const upstreamExtra = [step("2026-09-26T09:20:00Z", "tomas", "docs: link the postgres bump ticket in the runbook", { "docs/runbook.md": runbook3 })];

// ---------------------------------------------------------------------------------------------------- work tree
const worktree = {
  modify: {
    "modules/database/main.tf": dbMainFinal,
    "deploy/api.yaml": apiDeployFinal,
    "environments/staging/terraform.tfvars": stagingTfvarsStaged,
  },
  stage: ["environments/staging/terraform.tfvars"],
  hunkTargets: [{ path: "modules/database/main.tf", hunks: 3 }],
};

export default {
  id: "fb-infra",
  name: "fb-infra",
  branch: FEATURE,
  files,
  history,
  worktree,
  // Reused by the optional infra mock run: the connection limit goes from 200 to 300.
  agentEdit: { path: "modules/database/main.tf", before: DB_BEFORE, after: DB_AFTER },
  upstream: { ahead: 0, behind: 1 },
  upstreamExtra,
};

/** Ticket ids that other repositories of the story refer to as well (FB-248 and FB-214 come from fb-api). */
export const TICKETS = ["FB-214", "FB-240", "FB-248"];
