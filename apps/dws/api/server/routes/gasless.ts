import { Elysia } from 'elysia'
import { bootstrapGaslessSmartAccount } from '../../services/gasless-bootstrap'

export const gaslessRoutes = new Elysia({ prefix: '/gasless' }).post(
  '/bootstrap',
  async ({ body, set }) => {
    try {
      return await bootstrapGaslessSmartAccount(body)
    } catch (error) {
      set.status = 400
      return {
        error:
          error instanceof Error ? error.message : 'Failed to bootstrap gasless account',
      }
    }
  },
)
