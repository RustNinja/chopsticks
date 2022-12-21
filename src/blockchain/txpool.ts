import { Header, RawBabePreDigest, Slot } from '@polkadot/types/interfaces'
import { HexString } from '@polkadot/util/types'
import { compactAddLength } from '@polkadot/util'
import _ from 'lodash'

import { Block } from './block'
import { Blockchain } from '.'
import { InherentProvider } from './inherent'
import { ResponseError } from '../rpc/shared'
import { compactHex } from '../utils'
import { defaultLogger, truncate, truncateStorageDiff } from '../logger'

const logger = defaultLogger.child({ name: 'txpool' })

export enum BuildBlockMode {
  Batch, // one block per batch, default
  Instant, // one block per tx
  Manual, // only build when triggered
}

const getConsensus = (header: Header) => {
  if (header.digest.logs.length === 0) return
  const preRuntime = header.digest.logs[0].asPreRuntime
  const [consensusEngine, slot] = preRuntime
  return { consensusEngine, slot, rest: header.digest.logs.slice(1) }
}

const getNewSlot = (slot: RawBabePreDigest) => {
  if (slot.isPrimary) {
    const primary = slot.asPrimary.toJSON()
    return {
      primary: {
        ...primary,
        slotNumber: (primary.slotNumber as number) + 1,
      },
    }
  }
  if (slot.isSecondaryPlain) {
    const secondaryPlain = slot.asSecondaryPlain.toJSON()
    return {
      secondaryPlain: {
        ...secondaryPlain,
        slotNumber: (secondaryPlain.slotNumber as number) + 1,
      },
    }
  }
  if (slot.isSecondaryVRF) {
    const secondaryVRF = slot.asSecondaryVRF.toJSON()
    return {
      secondaryVRF: {
        ...secondaryVRF,
        slotNumber: (secondaryVRF.slotNumber as number) + 1,
      },
    }
  }
  return slot.toJSON()
}

export class TxPool {
  readonly #chain: Blockchain
  readonly #pool: HexString[] = []
  readonly #mode: BuildBlockMode
  readonly #inherentProvider: InherentProvider

  #lastBuildBlockPromise: Promise<void> = Promise.resolve()

  constructor(chain: Blockchain, inherentProvider: InherentProvider, mode: BuildBlockMode = BuildBlockMode.Batch) {
    this.#chain = chain
    this.#mode = mode
    this.#inherentProvider = inherentProvider
  }

  get pendingExtrinsics(): HexString[] {
    return this.#pool
  }

  submitExtrinsic(extrinsic: HexString) {
    this.#pool.push(extrinsic)

    switch (this.#mode) {
      case BuildBlockMode.Batch:
        this.#batchBuildBlock()
        break
      case BuildBlockMode.Instant:
        this.buildBlock()
        break
      case BuildBlockMode.Manual:
        // does nothing
        break
    }
  }

  #batchBuildBlock = _.debounce(this.buildBlock, 100, { maxWait: 1000 })

  async buildBlock() {
    const last = this.#lastBuildBlockPromise
    this.#lastBuildBlockPromise = this.#buildBlock(last)
    await this.#lastBuildBlockPromise
  }

  async #buildBlock(wait: Promise<void>) {
    await this.#chain.api.isReady
    await wait.catch(() => {}) // ignore error
    const head = this.#chain.head
    const extrinsics = this.#pool.splice(0)

    const meta = await head.meta
    const parentHeader = await head.header

    let newLogs = parentHeader.digest.logs as any
    const consensus = getConsensus(parentHeader)
    if (consensus?.consensusEngine.isAura) {
      const slot = meta.registry.createType<Slot>('Slot', consensus.slot).toNumber()
      const newSlot = meta.registry.createType('Slot', slot + 1).toU8a()
      newLogs = [{ PreRuntime: [consensus.consensusEngine, compactAddLength(newSlot)] }, ...consensus.rest]
    } else if (consensus?.consensusEngine.isBabe) {
      const slot = meta.registry.createType<RawBabePreDigest>('RawBabePreDigest', consensus.slot)
      const newSlot = meta.registry.createType('RawBabePreDigest', getNewSlot(slot)).toU8a()
      newLogs = [{ PreRuntime: [consensus.consensusEngine, compactAddLength(newSlot)] }, ...consensus.rest]
    }

    const registry = await head.registry
    const header: Header = registry.createType('Header', {
      parentHash: head.hash,
      number: head.number + 1,
      stateRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      extrinsicsRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      digest: {
        logs: newLogs,
      },
    })

    const newBlock = this.#chain.newTempBlock(head, header)

    logger.info(
      {
        hash: head.hash,
        number: head.number,
        extrinsicsCount: extrinsics.length,
        tempHash: newBlock.hash,
      },
      'Building block'
    )

    const resp = await newBlock.call('Core_initialize_block', header.toHex())
    logger.trace(truncateStorageDiff(resp.storageDiff), 'Initialize block')

    newBlock.pushStorageLayer().setAll(resp.storageDiff)

    const inherents = await this.#inherentProvider.createInherents(newBlock)
    for (const extrinsic of inherents) {
      try {
        const resp = await newBlock.call('BlockBuilder_apply_extrinsic', extrinsic)
        newBlock.pushStorageLayer().setAll(resp.storageDiff)
        logger.trace(truncateStorageDiff(resp.storageDiff), 'Applied inherent')
      } catch (e) {
        logger.warn('Failed to apply inherents %o %s', e, e)
        throw new ResponseError(1, 'Failed to apply inherents')
      }
    }

    for (const extrinsic of extrinsics) {
      try {
        const resp = await newBlock.call('BlockBuilder_apply_extrinsic', extrinsic)
        newBlock.pushStorageLayer().setAll(resp.storageDiff)
        logger.trace(truncateStorageDiff(resp.storageDiff), 'Applied extrinsic')
      } catch (e) {
        logger.info('Failed to apply extrinsic %o %s', e, e)
        this.#pool.push(extrinsic)
      }
    }

    if (meta.query.paraInherent?.included) {
      // TODO: remvoe this once paraInherent.enter is implemented
      // we are relaychain, however as we have not yet implemented the paraInherent.enter
      // so need to do some trick to make the on_finalize check happy
      const paraInherentIncludedKey = compactHex(meta.query.paraInherent.included())
      newBlock.pushStorageLayer().set(paraInherentIncludedKey, '0x01')
    }

    const resp2 = await newBlock.call('BlockBuilder_finalize_block', '0x')

    newBlock.pushStorageLayer().setAll(resp2.storageDiff)
    logger.trace(truncateStorageDiff(resp2.storageDiff), 'Finalize block')

    const blockData = registry.createType('Block', {
      header,
      extrinsics,
    })

    const finalBlock = new Block(this.#chain, newBlock.number, blockData.hash.toHex(), head, {
      header,
      extrinsics: [...inherents, ...extrinsics],
      storage: head.storage,
    })

    const diff = await newBlock.storageDiff()
    logger.trace(
      Object.entries(diff).map(([key, value]) => [key, truncate(value)]),
      'Final block'
    )
    finalBlock.pushStorageLayer().setAll(diff)

    this.#chain.unregisterBlock(newBlock)
    await this.#chain.setHead(finalBlock)

    logger.info({ hash: finalBlock.hash, number: finalBlock.number, prevHash: newBlock.hash }, 'Block built')
  }
}
