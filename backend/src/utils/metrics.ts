import {
    Counter,
    Gauge,
    Histogram,
    Registry,
    collectDefaultMetrics,
} from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ app: "virtual-proxmox-lab-backend" });
collectDefaultMetrics({ register: registry });

// ---------- HTTP ----------
export const httpRequestsTotal = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests handled by the backend",
    labelNames: ["method", "route", "status"] as const,
    registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
});

export const httpInFlightRequests = new Gauge({
    name: "http_in_flight_requests",
    help: "HTTP requests currently being processed",
    registers: [registry],
});

// ---------- Business / domain ----------
export const vlabUsersTotal = new Gauge({
    name: "vlab_users_total",
    help: "Total users in the database, grouped by role",
    labelNames: ["role"] as const,
    registers: [registry],
});

export const vlabInstancesTotal = new Gauge({
    name: "vlab_instances_total",
    help: "Total instances in the database, grouped by status",
    labelNames: ["status"] as const,
    registers: [registry],
});

export const vlabTemplatesTotal = new Gauge({
    name: "vlab_templates_total",
    help: "Total templates in the database, grouped by type",
    labelNames: ["type"] as const,
    registers: [registry],
});

export const vlabInstanceLifecycleTotal = new Counter({
    name: "vlab_instance_lifecycle_total",
    help: "Lifecycle operations on instances",
    labelNames: ["op", "result"] as const,
    registers: [registry],
});

export const vlabInstanceCreateDurationSeconds = new Histogram({
    name: "vlab_instance_create_duration_seconds",
    help: "End-to-end duration of instance creation (clone + config + DB insert)",
    buckets: [1, 2.5, 5, 10, 20, 30, 60, 120, 300],
    registers: [registry],
});

export const vlabInstancesExpiredRemovedTotal = new Counter({
    name: "vlab_instances_expired_removed_total",
    help: "Instances removed by the expiry sweep",
    registers: [registry],
});

// ---------- Proxmox ----------
export const proxmoxNodeUp = new Gauge({
    name: "proxmox_node_up",
    help: "1 if the Proxmox node reports online, 0 otherwise",
    labelNames: ["node"] as const,
    registers: [registry],
});

export const proxmoxNodeCpuRatio = new Gauge({
    name: "proxmox_node_cpu_ratio",
    help: "Proxmox node CPU usage ratio (0-1)",
    labelNames: ["node"] as const,
    registers: [registry],
});

export const proxmoxNodeMemBytes = new Gauge({
    name: "proxmox_node_mem_bytes",
    help: "Proxmox node memory in bytes",
    labelNames: ["node", "kind"] as const,
    registers: [registry],
});

export const proxmoxStorageBytes = new Gauge({
    name: "proxmox_storage_bytes",
    help: "Proxmox storage usage in bytes",
    labelNames: ["node", "storage", "kind"] as const,
    registers: [registry],
});

export const proxmoxVmsTotal = new Gauge({
    name: "proxmox_vms_total",
    help: "Total Proxmox VMs visible to the backend, grouped by status",
    labelNames: ["status"] as const,
    registers: [registry],
});

export const proxmoxVmCpuRatio = new Gauge({
    name: "proxmox_vm_cpu_ratio",
    help: "Proxmox VM CPU usage ratio (0-1)",
    labelNames: ["vmid", "name"] as const,
    registers: [registry],
});

export const proxmoxVmMemBytes = new Gauge({
    name: "proxmox_vm_mem_bytes",
    help: "Proxmox VM memory in bytes",
    labelNames: ["vmid", "name", "kind"] as const,
    registers: [registry],
});

export const proxmoxVmUptimeSeconds = new Gauge({
    name: "proxmox_vm_uptime_seconds",
    help: "Proxmox VM uptime in seconds",
    labelNames: ["vmid", "name"] as const,
    registers: [registry],
});

export const proxmoxVmNetBytesTotal = new Gauge({
    name: "proxmox_vm_net_bytes_total",
    help: "Proxmox VM cumulative network bytes (counter-like gauge sourced from /cluster/resources)",
    labelNames: ["vmid", "name", "direction"] as const,
    registers: [registry],
});

export const proxmoxApiErrorsTotal = new Counter({
    name: "proxmox_api_errors_total",
    help: "Errors returned by the Proxmox API client",
    labelNames: ["op"] as const,
    registers: [registry],
});

// ---------- Guacamole ----------
export const guacamoleUsersTotal = new Gauge({
    name: "guacamole_users_total",
    help: "Total Guacamole users",
    registers: [registry],
});

export const guacamoleConnectionsTotal = new Gauge({
    name: "guacamole_connections_total",
    help: "Total Guacamole connections",
    registers: [registry],
});

export const guacamoleActiveSessions = new Gauge({
    name: "guacamole_active_sessions",
    help: "Sum of activeConnections across all Guacamole connections",
    registers: [registry],
});

export const guacamoleApiErrorsTotal = new Counter({
    name: "guacamole_api_errors_total",
    help: "Errors returned by the Guacamole API client",
    labelNames: ["op"] as const,
    registers: [registry],
});

// ---------- Poll-loop health ----------
export const metricsPollDurationSeconds = new Histogram({
    name: "vlab_metrics_poll_duration_seconds",
    help: "Duration of the metrics poller, by source",
    labelNames: ["source"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
});

export const metricsPollLastSuccessTimestamp = new Gauge({
    name: "vlab_metrics_poll_last_success_timestamp",
    help: "Unix timestamp of the last successful poll, by source",
    labelNames: ["source"] as const,
    registers: [registry],
});
