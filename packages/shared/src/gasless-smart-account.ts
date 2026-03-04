import type {
  Account,
  Address,
  Chain,
  Client,
  Hex,
  JsonRpcAccount,
  LocalAccount,
  Transport,
  WalletClient,
} from 'viem'
import { decodeFunctionData, encodeFunctionData } from 'viem'
import {
  entryPoint06Abi,
  entryPoint07Abi,
  entryPoint08Abi,
  entryPoint09Abi,
  getUserOperationHash,
  getUserOperationTypedData,
  toSmartAccount,
  type EntryPointVersion,
  type SmartAccount,
  type SmartAccountImplementation,
  type UserOperation,
} from 'viem/account-abstraction'
import { getChainId, signMessage } from 'viem/actions'
import { getAction } from 'viem/utils'
import { getAccountNonce, getSenderAddress } from 'permissionless/actions'

const CREATE_ACCOUNT_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'uint256', name: 'salt', type: 'uint256' },
    ],
    name: 'createAccount',
    outputs: [{ internalType: 'contract SimpleAccount', name: 'ret', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const EXECUTE_SINGLE_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'dest', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
      { internalType: 'bytes', name: 'func', type: 'bytes' },
    ],
    name: 'execute',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const EXECUTE_BATCH_06_ABI = [
  {
    inputs: [
      { internalType: 'address[]', name: 'dest', type: 'address[]' },
      { internalType: 'bytes[]', name: 'func', type: 'bytes[]' },
    ],
    name: 'executeBatch',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const EXECUTE_BATCH_07_ABI = [
  {
    inputs: [
      { internalType: 'address[]', name: 'dest', type: 'address[]' },
      { internalType: 'uint256[]', name: 'value', type: 'uint256[]' },
      { internalType: 'bytes[]', name: 'func', type: 'bytes[]' },
    ],
    name: 'executeBatch',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const EXECUTE_BATCH_08_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'target', type: 'address' },
          { internalType: 'uint256', name: 'value', type: 'uint256' },
          { internalType: 'bytes', name: 'data', type: 'bytes' },
        ],
        internalType: 'struct Call[]',
        name: 'calls',
        type: 'tuple[]',
      },
    ],
    name: 'executeBatch',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

type WalletCall = {
  to: Address
  data?: Hex
  value?: bigint
}

function getEntryPointAbi(entryPointVersion: EntryPointVersion) {
  switch (entryPointVersion) {
    case '0.9':
      return entryPoint09Abi
    case '0.8':
      return entryPoint08Abi
    case '0.7':
      return entryPoint07Abi
    default:
      return entryPoint06Abi
  }
}

function getIsTypedDataVersion(entryPointVersion: EntryPointVersion) {
  return entryPointVersion === '0.8' || entryPointVersion === '0.9'
}

export type JejuSimpleSmartAccountImplementation<
  entryPointVersion extends EntryPointVersion = EntryPointVersion,
> = SmartAccountImplementation<
  ReturnType<typeof getEntryPointAbi>,
  entryPointVersion
>

export type JejuSimpleSmartAccount<
  entryPointVersion extends EntryPointVersion = EntryPointVersion,
> = SmartAccount<JejuSimpleSmartAccountImplementation<entryPointVersion>>

export async function toJejuSimpleSmartAccount<
  entryPointVersion extends EntryPointVersion,
>(parameters: {
  client: Client<
    Transport,
    Chain | undefined,
    JsonRpcAccount | LocalAccount | undefined
  >
  owner: WalletClient<Transport, Chain | undefined, Account>
  entryPoint: {
    address: Address
    version: entryPointVersion
  }
  factoryAddress: Address
  address?: Address
  index?: bigint
  nonceKey?: bigint
}): Promise<JejuSimpleSmartAccount<entryPointVersion>> {
  const {
    client,
    owner,
    entryPoint,
    factoryAddress,
    address,
    index = 0n,
    nonceKey,
  } = parameters

  if (!owner.account) {
    throw new Error('Connected wallet has no active account')
  }

  const localOwner = owner.account

  const getFactoryArgs = async () => {
    return {
      factory: factoryAddress,
      factoryData: encodeFunctionData({
        abi: CREATE_ACCOUNT_ABI,
        functionName: 'createAccount',
        args: [localOwner.address, index],
      }),
    }
  }

  const accountAddress =
    address ??
    (await (async () => {
      const { factory, factoryData } = await getFactoryArgs()
      return getSenderAddress(client, {
        factory,
        factoryData,
        entryPointAddress: entryPoint.address,
      })
    })())

  let chainId: number | undefined
  const getMemoizedChainId = async () => {
    if (chainId) return chainId
    chainId = client.chain
      ? client.chain.id
      : await getAction(client, getChainId, 'getChainId')({})
    return chainId
  }

  return toSmartAccount({
    client,
    entryPoint: {
      address: entryPoint.address,
      abi: getEntryPointAbi(entryPoint.version),
      version: entryPoint.version,
    },
    getFactoryArgs,
    async getAddress() {
      return accountAddress
    },
    async encodeCalls(calls) {
      if (calls.length > 1) {
        if (entryPoint.version === '0.9' || entryPoint.version === '0.8') {
          return encodeFunctionData({
            abi: EXECUTE_BATCH_08_ABI,
            functionName: 'executeBatch',
            args: [
              calls.map((call) => ({
                target: call.to,
                value: call.value ?? 0n,
                data: call.data ?? '0x',
              })),
            ],
          })
        }

        if (entryPoint.version === '0.7') {
          return encodeFunctionData({
            abi: EXECUTE_BATCH_07_ABI,
            functionName: 'executeBatch',
            args: [
              calls.map((call) => call.to),
              calls.map((call) => call.value ?? 0n),
              calls.map((call) => call.data ?? '0x'),
            ],
          })
        }

        return encodeFunctionData({
          abi: EXECUTE_BATCH_06_ABI,
          functionName: 'executeBatch',
          args: [
            calls.map((call) => call.to),
            calls.map((call) => call.data ?? '0x'),
          ],
        })
      }

      const call = calls[0]
      if (!call) throw new Error('No calls to encode')

      return encodeFunctionData({
        abi: EXECUTE_SINGLE_ABI,
        functionName: 'execute',
        args: [call.to, call.value ?? 0n, call.data ?? '0x'],
      })
    },
    async decodeCalls(callData) {
      try {
        const calls: WalletCall[] = []

        if (entryPoint.version === '0.9' || entryPoint.version === '0.8') {
          const decoded = decodeFunctionData({
            abi: EXECUTE_BATCH_08_ABI,
            data: callData,
          })

          for (const call of decoded.args[0]) {
            calls.push({
              to: call.target,
              data: call.data,
              value: call.value,
            })
          }

          return calls
        }

        if (entryPoint.version === '0.7') {
          const decoded = decodeFunctionData({
            abi: EXECUTE_BATCH_07_ABI,
            data: callData,
          })

          const destinations = decoded.args[0]
          const values = decoded.args[1]
          const datas = decoded.args[2]

          for (let i = 0; i < destinations.length; i++) {
            calls.push({
              to: destinations[i],
              data: datas[i],
              value: values[i],
            })
          }

          return calls
        }

        const decoded = decodeFunctionData({
          abi: EXECUTE_BATCH_06_ABI,
          data: callData,
        })

        const destinations = decoded.args[0]
        const datas = decoded.args[1]

        for (let i = 0; i < destinations.length; i++) {
          calls.push({
            to: destinations[i],
            data: datas[i],
            value: 0n,
          })
        }

        return calls
      } catch {
        const decoded = decodeFunctionData({
          abi: EXECUTE_SINGLE_ABI,
          data: callData,
        })

        return [
          {
            to: decoded.args[0],
            value: decoded.args[1],
            data: decoded.args[2],
          },
        ]
      }
    },
    async getNonce(args) {
      return getAccountNonce(client, {
        address: await this.getAddress(),
        entryPointAddress: entryPoint.address,
        key: nonceKey ?? args?.key,
      })
    },
    async getStubSignature() {
      return '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c'
    },
    async sign({ hash }) {
      return this.signMessage({ message: hash })
    },
    async signMessage() {
      throw new Error("Simple account isn't 1271 compliant")
    },
    async signTypedData() {
      throw new Error("Simple account isn't 1271 compliant")
    },
    async signUserOperation(parameters) {
      const { chainId = await getMemoizedChainId(), ...userOperation } =
        parameters

      if (getIsTypedDataVersion(entryPoint.version)) {
        const typedData = getUserOperationTypedData({
          chainId,
          entryPointAddress: entryPoint.address,
          userOperation: {
            ...userOperation,
            sender: await this.getAddress(),
            signature: '0x',
          },
        })
        return owner.signTypedData(typedData as never)
      }

      return signMessage(client, {
        account: localOwner,
        message: {
          raw: getUserOperationHash({
            userOperation: {
              ...userOperation,
              sender: userOperation.sender ?? (await this.getAddress()),
              signature: '0x',
            } as UserOperation<entryPointVersion>,
            entryPointAddress: entryPoint.address,
            entryPointVersion: entryPoint.version,
            chainId,
          }),
        },
      })
    },
  }) as Promise<JejuSimpleSmartAccount<entryPointVersion>>
}
