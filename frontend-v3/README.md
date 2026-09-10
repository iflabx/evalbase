# EvalBase Web

The formal EvalBase React frontend. It is built with Vite and served by the root Fastify application.

Run commands from the repository root:

```bash
npm --prefix frontend-v3 ci
npm --prefix frontend-v3 run typecheck
npm --prefix frontend-v3 run lint
npm --prefix frontend-v3 run build:formal
```

The root `npm run build` is the supported build command.
