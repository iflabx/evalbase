# Frontend Architecture

`frontend-v3/` is the only formal web frontend. It uses React, Vite, TanStack Router, and the repository's shared UI primitives; its built assets are served by the root Fastify application.

The [frozen interaction prototype](../prototypes/THROWAWAY-phase1a-solo-workflow-ui.html) defines visible pages, controls, and workflow order. The implementation must preserve those user-facing boundaries while using the existing HTTP API and domain modules.

Frontend changes should keep normal, empty, error, pagination, dialog, and destructive-action states consistent with the prototype. No alternative frontend runtime or second deployment unit is supported.
