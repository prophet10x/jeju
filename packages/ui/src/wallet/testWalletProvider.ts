import {
  type Chain,
  createWalletClient,
  type EIP1193Provider,
  type EIP1193RequestFn,
  fromHex,
  getAddress,
  type Hex,
  http,
  isHex,
  numberToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpc } from 'viem/utils'

export interface TestWalletProviderOptions {
  chains: readonly Chain[]
  privateKey: Hex
}

const DEFAULT_CHAIN_ID = 1

interface ListenerMap {
  accountsChanged: Set<(accounts: string[]) => void>
  chainChanged: Set<(chainId: Hex) => void>
  connect: Set<(info: { chainId: Hex }) => void>
  disconnect: Set<(error?: { code: number; message: string }) => void>
}

function parseHexBigInt(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (!isHex(value)) return undefined
  try {
    return fromHex(value, 'bigint')
  } catch {
    return undefined
  }
}

function parseHexNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (!isHex(value)) return undefined
  try {
    return fromHex(value, 'number')
  } catch {
    return undefined
  }
}

function getMessageForSigning(value: unknown): string | { raw: Hex } {
  if (typeof value !== 'string') return String(value ?? '')
  return isHex(value) ? { raw: value } : value
}

export function createTestWalletProvider({
  chains,
  privateKey,
}: TestWalletProviderOptions): EIP1193Provider {
  const account = privateKeyToAccount(privateKey)
  const accountAddress = getAddress(account.address)
  const listeners: ListenerMap = {
    accountsChanged: new Set(),
    chainChanged: new Set(),
    connect: new Set(),
    disconnect: new Set(),
  }

  let connected = false
  let currentChainId = chains[0]?.id ?? DEFAULT_CHAIN_ID
  const sentCallHashes = new Map<string, Hex[]>()

  const getChain = (chainId = currentChainId): Chain | undefined =>
    chains.find((chain) => chain.id === chainId)

  const getRpcUrl = (chainId = currentChainId): string => {
    const chain = getChain(chainId)
    return chain?.rpcUrls?.default?.http?.[0] ?? ''
  }

  const emitAccountsChanged = () => {
    const accounts = connected ? [accountAddress] : []
    for (const listener of Array.from(listeners.accountsChanged)) {
      listener(accounts)
    }
  }

  const emitChainChanged = () => {
    const chainHex = numberToHex(currentChainId)
    for (const listener of Array.from(listeners.chainChanged)) {
      listener(chainHex)
    }
  }

  const request: EIP1193RequestFn = async ({ method, params }) => {
    if (method === 'eth_chainId') return numberToHex(currentChainId)

    if (method === 'eth_accounts') {
      return connected ? [accountAddress] : []
    }

    if (method === 'eth_requestAccounts') {
      connected = true
      const chainHex = numberToHex(currentChainId)
      for (const listener of Array.from(listeners.connect)) {
        listener({ chainId: chainHex })
      }
      emitAccountsChanged()
      return [accountAddress]
    }

    if (method === 'wallet_requestPermissions') {
      connected = true
      emitAccountsChanged()
      return [
        {
          parentCapability: 'eth_accounts',
          caveats: [
            {
              type: 'filterResponse',
              value: [accountAddress],
            },
          ],
        },
      ]
    }

    if (method === 'wallet_revokePermissions') {
      connected = false
      emitAccountsChanged()
      for (const listener of Array.from(listeners.disconnect)) {
        listener({ code: 4900, message: 'Disconnected' })
      }
      return true
    }

    if (method === 'wallet_switchEthereumChain') {
      const requestedChainId = parseHexNumber(
        (params?.[0] as { chainId?: string } | undefined)?.chainId,
      )
      if (!requestedChainId || !getChain(requestedChainId)) {
        throw {
          code: 4902,
          message: 'Unrecognized chain.',
        }
      }
      currentChainId = requestedChainId
      emitChainChanged()
      return null
    }

    if (method === 'wallet_addEthereumChain') {
      const requestedChainId = parseHexNumber(
        (params?.[0] as { chainId?: string } | undefined)?.chainId,
      )
      if (requestedChainId && getChain(requestedChainId)) {
        currentChainId = requestedChainId
        emitChainChanged()
        return null
      }
      throw {
        code: 4902,
        message: 'Chain is not configured in test wallet allowlist.',
      }
    }

    if (method === 'personal_sign') {
      const message = getMessageForSigning((params as unknown[])?.[0])
      return account.signMessage({ message })
    }

    if (method === 'eth_sign') {
      const message = getMessageForSigning((params as unknown[])?.[1])
      return account.signMessage({ message })
    }

    if (method === 'eth_signTypedData_v4') {
      const rawPayload = (params as unknown[])?.[1]
      const parsedPayload =
        typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload
      return account.signTypedData(parsedPayload as never)
    }

    if (method === 'eth_sendTransaction') {
      connected = true
      const tx = ((params as unknown[])?.[0] ?? {}) as {
        from?: string
        to?: string
        data?: Hex
        value?: string
        gas?: string
        gasPrice?: string
        maxFeePerGas?: string
        maxPriorityFeePerGas?: string
        nonce?: string
        chainId?: string
      }

      if (tx.from && getAddress(tx.from) !== accountAddress) {
        throw new Error('Transaction from address does not match test wallet')
      }

      const txChainId = parseHexNumber(tx.chainId) ?? currentChainId
      const chain = getChain(txChainId)
      if (!chain) {
        throw new Error(`Unsupported chain id ${txChainId} for test wallet`)
      }
      currentChainId = txChainId

      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(getRpcUrl(txChainId)),
      })

      return walletClient.sendTransaction({
        account,
        chain,
        to: tx.to ? getAddress(tx.to) : undefined,
        data: tx.data,
        value: parseHexBigInt(tx.value),
        gas: parseHexBigInt(tx.gas),
        gasPrice: parseHexBigInt(tx.gasPrice),
        maxFeePerGas: parseHexBigInt(tx.maxFeePerGas),
        maxPriorityFeePerGas: parseHexBigInt(tx.maxPriorityFeePerGas),
        nonce: parseHexNumber(tx.nonce),
      } as never)
    }

    if (method === 'wallet_sendCalls') {
      const payload = ((params as unknown[])?.[0] ?? {}) as {
        from?: string
        calls?: Array<{ to: string; data?: Hex; value?: string }>
      }
      const calls = payload.calls ?? []
      const hashes: Hex[] = []
      for (const call of calls) {
        const hash = (await request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: payload.from ?? accountAddress,
              to: call.to,
              data: call.data,
              value: call.value ?? '0x0',
            },
          ],
        })) as Hex
        hashes.push(hash)
      }
      const id = `0x${crypto.randomUUID().split('-').join('')}` as Hex
      sentCallHashes.set(id, hashes)
      return { id }
    }

    if (method === 'wallet_getCallsStatus') {
      const id = (params as unknown[])?.[0] as Hex | undefined
      const hashes = id ? sentCallHashes.get(id) : undefined
      if (!hashes?.length) {
        return {
          atomic: false,
          chainId: numberToHex(currentChainId),
          id,
          status: 100,
          receipts: [],
          version: '2.0.0',
        }
      }

      const url = getRpcUrl(currentChainId)
      const receipts = await Promise.all(
        hashes.map(async (hash) => {
          const { result } = await rpc.http(url, {
            body: {
              method: 'eth_getTransactionReceipt',
              params: [hash],
            },
          })
          return result
        }),
      )

      const resolvedReceipts = receipts.filter(Boolean)
      return {
        atomic: false,
        chainId: numberToHex(currentChainId),
        id,
        status: resolvedReceipts.length === hashes.length ? 200 : 100,
        receipts: resolvedReceipts,
        version: '2.0.0',
      }
    }

    if (method === 'wallet_showCallsStatus') return null

    const url = getRpcUrl(currentChainId)
    const { result, error } = await rpc.http(url, {
      body: {
        method,
        params,
      },
    })
    if (error) {
      throw new Error(error.message ?? `RPC request failed: ${method}`)
    }
    return result
  }

  return {
    request,
    on(event, listener) {
      const eventName = event as keyof ListenerMap
      const typedListener = listener as never
      listeners[eventName]?.add(typedListener)
    },
    removeListener(event, listener) {
      const eventName = event as keyof ListenerMap
      const typedListener = listener as never
      listeners[eventName]?.delete(typedListener)
    },
  } as EIP1193Provider
}
