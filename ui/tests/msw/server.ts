import { setupServer } from 'msw/node'

// Tests must register explicit handlers with `server.use(...)`.
// We intentionally avoid global seeded API data so missing handlers fail loudly.
export const server = setupServer()
