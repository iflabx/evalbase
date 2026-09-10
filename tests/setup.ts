// Ordinary test Workers do not need a health listener; keep parallel spawns isolated.
process.env.WORKER_HEALTH_PORT ??= "0";
