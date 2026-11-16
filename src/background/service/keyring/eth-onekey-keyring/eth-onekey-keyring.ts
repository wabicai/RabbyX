import EventEmitter from 'events';
import {
  toChecksumAddress,
  stripHexPrefix,
  addHexPrefix,
  publicToAddress,
  bufferToHex,
} from '@ethereumjs/util';
import * as sigUtil from 'eth-sig-util';
import type { Response } from '@onekeyfe/hd-core';
import { HardwareErrorCode } from '@onekeyfe/hd-shared';
import { t } from 'i18next';
import {
  FeeMarketEIP1559Transaction,
  Transaction,
  TransactionFactory,
  TypedTransaction,
} from '@ethereumjs/tx';
import HDKey from 'hdkey';
import { isSameAddress } from '@/background/utils';
import { OneKeyBridgeInterface } from './onekey-bridge-interface';
import { isManifestV3 } from '@/utils/env';
import browser from 'webextension-polyfill';

const keyringType = 'Onekey Hardware';
const hdPathString = "m/44'/60'/0'/0";
const pathBase = 'm';
const MAX_INDEX = 1000;
const DELAY_BETWEEN_POPUPS = 1000;
const ONEKEY_SESSION_STATE_KEY = 'onekeySessionState';
// HardwareErrorCode.DeviceNotOpenedPassphrase from @onekeyfe/hd-shared
const DEVICE_NOT_OPENED_PASSPHRASE = 113;

function handleDeviceError(
  errorCode: string | number | undefined,
  errorMessage: string
) {
  let msg = errorMessage;
  switch (errorCode?.toString()) {
    case DEVICE_NOT_OPENED_PASSPHRASE.toString():
      msg = t('background.keyring.onekey.deviceNotOpenedPassphrase');
      break;
    case HardwareErrorCode.DeviceNotFound.toString():
      msg = t('background.keyring.onekey.notFoundDevice');
      break;
    case HardwareErrorCode.WebDeviceNotFoundOrNeedsPermission.toString():
      msg = t('background.keyring.onekey.deviceNeedsWebHIDPermission');
      break;
    case HardwareErrorCode.DeviceInterruptedFromOutside.toString():
    case HardwareErrorCode.DeviceInterruptedFromUser.toString():
      msg = t('background.keyring.onekey.deviceInterrupted');
      break;
    case HardwareErrorCode.PinInvalid.toString():
      msg = t('background.keyring.onekey.pinInvalid');
      break;
    case HardwareErrorCode.DeviceBusy.toString():
      msg = t('background.keyring.onekey.deviceBusy');
      break;
    case HardwareErrorCode.CallQueueActionCancelled.toString():
    case HardwareErrorCode.ActionCancelled.toString():
    case HardwareErrorCode.PinCancelled.toString():
      msg = t('background.keyring.onekey.actionCancel');
      break;
    case HardwareErrorCode.DeviceInitializeFailed.toString():
      msg = t('background.keyring.onekey.deviceInitializeFailed');
      break;
    case HardwareErrorCode.NewFirmwareForceUpdate.toString():
      msg = t('background.keyring.onekey.needUpgradeFirmware');
      break;
    case HardwareErrorCode.CallMethodNeedUpgradeFirmware.toString():
      msg = t('background.keyring.onekey.thisMethodNeedUpgradeFirmware');
      break;
    case HardwareErrorCode.DeviceDetectInBootloaderMode.toString():
    case HardwareErrorCode.NotAllowInBootloaderMode.toString():
      msg = t('background.keyring.onekey.notAllowInBootloaderMode');
      break;
    case HardwareErrorCode.DeviceCheckPassphraseStateError.toString():
    case HardwareErrorCode.DeviceCheckUnlockTypeError.toString():
      msg = t('background.keyring.onekey.deviceCheckPassphraseStateError');
      break;
    default:
      msg = errorMessage;
  }

  const error = Object.assign(new Error(`${errorCode}: ${msg}`), {
    code:
      errorCode !== undefined && Number.isFinite(Number(errorCode))
        ? Number(errorCode)
        : errorCode,
  });
  handledDeviceErrors.add(error);
  return error;
}

const handledDeviceErrors = new WeakSet<Error>();

function toError(e: unknown): Error {
  if (e instanceof Error && handledDeviceErrors.has(e)) {
    return e;
  }
  const code = (e as any)?.code ?? (e as any)?.errorCode;
  if (code !== undefined && code !== null) {
    return handleDeviceError(
      code as string | number,
      (e as any)?.message ?? (e as any)?.error ?? 'Unknown error'
    );
  }
  if (e instanceof Error) {
    return e;
  }
  if (typeof e === 'string') {
    return new Error(e);
  }
  const payload = e as {
    message?: unknown;
    error?: unknown;
  } | null;
  const message = payload?.message ?? payload?.error;
  if (typeof message === 'string' && message) {
    return new Error(message);
  }
  try {
    return new Error(JSON.stringify(e) ?? 'Unknown error');
  } catch {
    return new Error('Unknown error');
  }
}

function isPassphraseDisabledError(payload?: {
  code?: unknown;
  error?: unknown;
}) {
  return (
    payload?.code === DEVICE_NOT_OPENED_PASSPHRASE ||
    /passphrase disabled/i.test(String(payload?.error ?? ''))
  );
}

function isUnsupportedWalletSessionError(payload: any) {
  const code = String(payload?.code ?? payload?.errorCode);
  return (
    code === '-32601' ||
    /^method[ _-]?not[ _-]?(allowed|found)$/i.test(code) ||
    /(?:action|method).*(?:not supported|unsupported|not found|not allowed)|(?:unsupported|unknown) (?:action|method)/i.test(
      String(payload?.error ?? payload?.message ?? payload ?? '')
    )
  );
}

interface OneKeySessionState {
  passphraseState: string | undefined;
  deviceId: string;
  connectId: string;
  publicKey: string;
  chainCode: string;
}

export enum LedgerHDPathType {
  LedgerLive = 'LedgerLive',
  Legacy = 'Legacy',
  BIP44 = 'BIP44',
}

type HDPathType = LedgerHDPathType;

interface Account {
  address: string;
  index: number;
}

interface AccountDetail {
  hdPathBasePublicKey?: string;
  hdPath: string;
  hdPathType: HDPathType;
  index: number;
  passphraseState?: string;
}

class OneKeyKeyring extends EventEmitter {
  static type = keyringType;
  type = keyringType;
  accounts: string[] = [];
  hdk = new HDKey();
  page = 0;
  perPage = 5;
  unlockedAccount = 0;
  paths = {};
  hdPath = '';
  deviceId: string | null = null;
  connectId: string | null = null;
  passphraseState: string | undefined = undefined;
  accountDetails: Record<string, AccountDetail>;

  bridge!: OneKeyBridgeInterface;

  constructor(
    opts: any & {
      bridge: OneKeyBridgeInterface;
    } = {}
  ) {
    super();
    if (!opts.bridge) {
      throw new Error('Bridge is required');
    }
    this.bridge = opts.bridge;
    this.accountDetails = {};
    this.deserialize(opts);
  }

  private sessionStatePromise?: Promise<void>;
  private restoreSessionState = true;
  private pendingConnectId: string | null = null;
  private pendingWorkCancelled = false;
  private passphraseStateCleared = false;

  async init() {
    await this.bridge.init();
    if (!this.sessionStatePromise) {
      this.sessionStatePromise = this.restoreStoredSession().catch((error) => {
        this.sessionStatePromise = undefined;
        throw error;
      });
    }
    return this.sessionStatePromise;
  }

  async searchDevices() {
    await this.init();
    return this.bridge.searchDevices();
  }

  consumePassphraseStateCleared(): boolean {
    const cleared = this.passphraseStateCleared;
    this.passphraseStateCleared = false;
    return cleared;
  }

  private _clearStoredSession() {
    if (!isManifestV3) {
      return;
    }
    // storage.session.remove is a Promise in MV3. Promise.resolve also
    // accepts a void return so a missing thenable cannot throw on .catch.
    return Promise.resolve(
      browser.storage.session.remove(ONEKEY_SESSION_STATE_KEY)
    ).catch((e) => console.log('failed to clear OneKey session state', e));
  }

  private _resetUnlockedSession() {
    this.restoreSessionState = false;
    this.sessionStatePromise = undefined;
    this.hdk = new HDKey();
    this.passphraseState = undefined;
    this.deviceId = null;
    this.connectId = null;
    return this._clearStoredSession();
  }

  private async restoreStoredSession() {
    if (isManifestV3) {
      // resume passphrase state from session after sw inactive
      const value = await browser.storage.session.get(ONEKEY_SESSION_STATE_KEY);
      const state: OneKeySessionState = value[ONEKEY_SESSION_STATE_KEY];
      if (state && this.restoreSessionState) {
        this.passphraseState = state.passphraseState;
        this.deviceId = state.deviceId;
        this.connectId = state.connectId;
        this.hdk.publicKey = Buffer.from(state.publicKey, 'hex');
        this.hdk.chainCode = Buffer.from(state.chainCode, 'hex');
      }
    }
  }

  serialize(): Promise<any> {
    return Promise.resolve({
      hdPath: this.hdPath,
      accounts: this.accounts,
      page: this.page,
      paths: this.paths,
      perPage: this.perPage,
      unlockedAccount: this.unlockedAccount,
      accountDetails: this.accountDetails,
    });
  }

  deserialize(opts: any = {}): Promise<void> {
    this.hdPath = opts.hdPath || hdPathString;
    this.accounts = opts.accounts || [];
    this.page = opts.page || 0;
    this.perPage = 5;
    this.paths = opts.paths || {};
    this.accountDetails = opts.accountDetails || {};
    return Promise.resolve();
  }

  isUnlocked(): boolean {
    return Boolean(this.hdk && this.hdk.publicKey);
  }

  private cancellationVersion = 0;
  private pendingSignings = 0;
  private unlockPromise?: Promise<string>;

  // Set when the open wallet did not own the signing account: the next
  // unlock asks the device to select a wallet instead of resuming it.
  private forceWalletSelectionOnUnlock = false;

  cancel() {
    this.cancellationVersion += 1;
    return this.bridge.cancel(
      this.pendingConnectId || this.connectId || undefined
    );
  }

  cleanUp(cancelPending = false) {
    // Import/manager pages call cleanUp(true) when they close. A signing on
    // this shared keyring is owned (and cancelled) by its approval instead.
    if (
      cancelPending &&
      this.pendingSignings > 0 &&
      !this.pendingWorkCancelled
    ) {
      return;
    }
    this.pendingWorkCancelled = false;
    const cancelPromise = cancelPending
      ? this.unlockPromise
        ? this.cancel()
        : ((this.cancellationVersion += 1), undefined)
      : undefined;
    const clearSessionPromise = this._resetUnlockedSession();
    if (cancelPromise || clearSessionPromise) {
      return Promise.all([cancelPromise, clearSessionPromise]).then(
        () => undefined
      );
    }
  }

  /**
   * Invalidate any in-flight unlock or signing (e.g. on wallet lock) and ask
   * the device to stop only when something is actually pending.
   */
  cancelPendingWork() {
    this.pendingWorkCancelled = true;
    if (this.unlockPromise || this.pendingSignings) return this.cancel();
    this.cancellationVersion += 1;
  }

  private _requireConnectedDevice() {
    if (!this.connectId || !this.deviceId) {
      throw handleDeviceError(
        HardwareErrorCode.DeviceNotFound,
        'No OneKey Device found'
      );
    }
    return {
      connectId: this.connectId,
      deviceId: this.deviceId,
    };
  }

  private async _clearStalePassphraseState(
    address: string,
    stalePassphraseState: string | undefined
  ) {
    const accountDetail = this.accountDetails[toChecksumAddress(address)];
    if (accountDetail && accountDetail.passphraseState !== undefined) {
      accountDetail.passphraseState = undefined;
      this.passphraseStateCleared = true;
    }

    const matchesActiveSession = this.passphraseState === stalePassphraseState;
    if (matchesActiveSession) {
      this.passphraseState = undefined;
      this.hdk = new HDKey();
      this.restoreSessionState = false;
      this.sessionStatePromise = undefined;
    }

    if (!isManifestV3) {
      return;
    }
    try {
      const value = await browser.storage.session.get(ONEKEY_SESSION_STATE_KEY);
      const state: OneKeySessionState | undefined =
        value[ONEKEY_SESSION_STATE_KEY];
      if (
        state &&
        (matchesActiveSession || state.passphraseState === stalePassphraseState)
      ) {
        // The cached session xpub/chainCode belonged to the stale hidden wallet;
        // drop it so the next unlock fetches the standard wallet identity.
        await browser.storage.session.remove(ONEKEY_SESSION_STATE_KEY);
      }
    } catch (e) {
      console.log('failed to clear OneKey session passphrase state', e);
    }
  }

  /**
   * The device can reject a signature with DeviceNotOpenedPassphrase (113)
   * when passphrase protection was turned off after this wallet was imported,
   * leaving a stale passphraseState. If the standard wallet provably owns the
   * account, drop the stale state and retry the same call once.
   */
  private async _withPassphraseRecovery<T>(
    address: string,
    params: Record<string, any>,
    call: (params: Record<string, any>) => Response<T>
  ): Response<T> {
    const cancellationVersion = this.cancellationVersion;
    const response = await call(params);
    if (
      response.success ||
      !isPassphraseDisabledError(response.payload) ||
      this._isEmptyPassphrase(params.passphraseState) ||
      cancellationVersion !== this.cancellationVersion
    ) {
      return response;
    }

    // Signing passes the same (possibly unset) ids: a single plugged-in
    // device signs fine without them, so the address check must too.
    const { connectId, deviceId } = this._requireConnectedDevice();
    const path = params.path;
    if (path === undefined) {
      return response;
    }

    let derivedAddress: string;
    try {
      const publicKey = await this.bridge.evmGetPublicKey(connectId, deviceId, {
        path,
        showOnOneKey: false,
        chainId: 1,
        useEmptyPassphrase: true,
      });
      if (
        !publicKey.success ||
        cancellationVersion !== this.cancellationVersion
      ) {
        return response;
      }
      derivedAddress = toChecksumAddress(
        bufferToHex(
          publicToAddress(Buffer.from(publicKey.payload.pub, 'hex'), true)
        )
      );
    } catch {
      return response;
    }
    if (!isSameAddress(derivedAddress, address)) {
      // A genuinely hidden wallet: surface the original error unchanged.
      return response;
    }

    await this._clearStalePassphraseState(address, params.passphraseState);

    if (cancellationVersion !== this.cancellationVersion) {
      return response;
    }

    return call({
      ...params,
      passphraseState: undefined,
      useEmptyPassphrase: true,
    });
  }

  unlock(): Promise<string> {
    if (!this.unlockPromise) {
      this.unlockPromise = this.unlockDevice().finally(() => {
        this.unlockPromise = undefined;
      });
    }
    return this.unlockPromise;
  }

  private async _resolveConnectedDevice(
    cancellationVersion?: number,
    options: { resetOnConnectIdChange?: boolean } = {}
  ) {
    const checkCancelled = () => {
      if (
        cancellationVersion !== undefined &&
        cancellationVersion !== this.cancellationVersion
      ) {
        throw new Error('OneKey signing cancelled');
      }
    };
    const result = await this.bridge.searchDevices();
    checkCancelled();
    if (!result.success) {
      throw handleDeviceError(result.payload.code, result.payload.error);
    }
    if (result.payload.length <= 0) {
      const state = await this.bridge.getDeviceState();
      checkCancelled();
      if (!state.success) {
        if (state.payload.code === HardwareErrorCode.DeviceNotFound) {
          throw handleDeviceError(
            HardwareErrorCode.DeviceNotFound,
            'No OneKey Device found'
          );
        }
        throw handleDeviceError(state.payload.code, state.payload.error);
      }
      throw handleDeviceError(
        HardwareErrorCode.DeviceNotFound,
        'No OneKey Device found'
      );
    }

    const previousConnectId = this.connectId;
    const previousDeviceId = this.deviceId;
    const device =
      result.payload.find((item) => item.connectId === previousConnectId) ||
      result.payload[0];
    const connectId = device?.connectId;
    if (!connectId) {
      throw handleDeviceError(
        HardwareErrorCode.DeviceNotFound,
        'No OneKey Device found'
      );
    }
    if (
      options.resetOnConnectIdChange &&
      previousConnectId &&
      connectId !== previousConnectId
    ) {
      await this._resetUnlockedSession();
      checkCancelled();
    }
    this.pendingConnectId = connectId;
    const state = await this.bridge.getDeviceState(connectId);
    checkCancelled();
    if (!state.success) {
      throw handleDeviceError(state.payload.code, state.payload.error);
    }
    const deviceId = state.payload.identity?.deviceId;
    if (!deviceId) {
      throw handleDeviceError(
        HardwareErrorCode.DeviceNotFound,
        'No OneKey Device found'
      );
    }
    const sameDeviceIdentity =
      Boolean(previousDeviceId && previousConnectId) &&
      previousDeviceId === deviceId &&
      previousConnectId === connectId;
    return {
      connectId,
      deviceId,
      state: state.payload,
      sameDeviceIdentity,
    };
  }

  private async unlockDevice(): Promise<string> {
    this.pendingWorkCancelled = false;
    const cancellationVersion = this.cancellationVersion;
    const checkCancelled = () => {
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('OneKey signing cancelled');
      }
    };
    try {
      await this.init();
      checkCancelled();
      const {
        connectId,
        deviceId,
        state,
        sameDeviceIdentity,
      } = await this._resolveConnectedDevice(cancellationVersion, {
        resetOnConnectIdChange: true,
      });

      if (sameDeviceIdentity && this.isUnlocked()) {
        return 'already unlocked';
      }
      if (!sameDeviceIdentity) {
        await this._resetUnlockedSession();
        checkCancelled();
      }

      const passphraseProtectionOff =
        state.status?.passphraseProtection === false;
      let passphraseState: string | undefined;
      const openWalletSession = this.bridge.openWalletSession;
      let walletSession:
        | Awaited<ReturnType<NonNullable<typeof openWalletSession>>>
        | undefined;
      // Follow Rabby's original flow on every device: getPassphraseState()
      // resumes the wallet the device already has open and otherwise asks
      // for the passphrase on the device. A Pro 2 uses openWalletSession
      // only where that call cannot: passphrase off (standard wallet), a
      // locked device or an attach-PIN session (the device must accept
      // any PIN), and a forced re-selection after the open wallet did not
      // own the signing account.
      const forceWalletSelection = this.forceWalletSelectionOnUnlock;
      this.forceWalletSelectionOnUnlock = false;
      const deviceStatus = state.status;
      const mainWalletUnlocked =
        deviceStatus?.unlocked === true &&
        deviceStatus?.unlockedAttachPin === false;
      if (
        state.protocol === 'V2' &&
        openWalletSession &&
        (passphraseProtectionOff || forceWalletSelection || !mainWalletUnlocked)
      ) {
        // The SDK rejects useEmptyPassphrase / passphraseState passed to
        // this call.
        const mode = passphraseProtectionOff ? 'standard' : 'select-hidden';
        try {
          walletSession = await openWalletSession.call(this.bridge, connectId, {
            mode,
          });
          checkCancelled();
          if (
            !walletSession.success &&
            mode === 'select-hidden' &&
            isPassphraseDisabledError(walletSession.payload)
          ) {
            walletSession = await openWalletSession.call(
              this.bridge,
              connectId,
              { mode: 'standard' }
            );
            checkCancelled();
          }
        } catch (error) {
          if (!isUnsupportedWalletSessionError(error)) {
            throw error;
          }
          walletSession = undefined;
        }
        if (
          walletSession &&
          !walletSession.success &&
          isUnsupportedWalletSessionError(walletSession.payload)
        ) {
          walletSession = undefined;
        }
      }
      checkCancelled();
      if (walletSession) {
        if (!walletSession.success) {
          throw handleDeviceError(
            walletSession.payload.code,
            walletSession.payload.error
          );
        }
        passphraseState = await this._resolvePassphraseStateForImport({
          connectId,
          protocol: state.protocol,
          walletType: walletSession.payload.walletType,
          passphraseState: walletSession.payload.passphraseState,
          cancellationVersion,
        });
      } else {
        // Legacy / Protocol V1 path.
        let standardWallet = passphraseProtectionOff;
        let currentPassphraseState = await this.bridge.getPassphraseState(
          connectId,
          standardWallet
            ? { useEmptyPassphrase: true }
            : forceWalletSelection
            ? { initSession: true }
            : undefined
        );
        checkCancelled();
        if (
          !currentPassphraseState.success &&
          !standardWallet &&
          isPassphraseDisabledError(currentPassphraseState.payload)
        ) {
          standardWallet = true;
          currentPassphraseState = await this.bridge.getPassphraseState(
            connectId,
            { useEmptyPassphrase: true }
          );
          checkCancelled();
        }
        if (!currentPassphraseState.success) {
          throw handleDeviceError(
            currentPassphraseState.payload.code,
            currentPassphraseState.payload.error
          );
        }
        // On V2 the standard-wallet session still returns a wallet id
        // (btc_test_address). Passing it on a passphrase-off device makes
        // the SDK throw DeviceNotOpenedPassphrase (113), so the standard
        // wallet is represented by an empty passphraseState.
        passphraseState = await this._resolvePassphraseStateForImport({
          connectId,
          protocol: state.protocol,
          passphraseState: standardWallet
            ? undefined
            : currentPassphraseState.payload || undefined,
          unlockedAttachPin: deviceStatus?.unlockedAttachPin,
          cancellationVersion,
        });
      }
      checkCancelled();
      const res = await this.bridge.evmGetPublicKey(connectId, deviceId, {
        showOnOneKey: false,
        chainId: 1,
        path: hdPathString,
        passphraseState,
        useEmptyPassphrase: this._isEmptyPassphrase(passphraseState),
      });
      checkCancelled();
      if (!res.success) {
        throw handleDeviceError(res.payload.code, res.payload.error);
      }
      const nextHdk = new HDKey();
      nextHdk.publicKey = Buffer.from(res.payload.pub, 'hex');
      nextHdk.chainCode = Buffer.from(res.payload.node.chain_code, 'hex');
      if (isManifestV3) {
        const sessionState: OneKeySessionState = {
          passphraseState,
          publicKey: res.payload.pub,
          chainCode: res.payload.node.chain_code,
          deviceId,
          connectId,
        };
        checkCancelled();
        await browser.storage.session.set({
          [ONEKEY_SESSION_STATE_KEY]: sessionState,
        });
        if (cancellationVersion !== this.cancellationVersion) {
          await this._clearStoredSession();
          throw new Error('OneKey signing cancelled');
        }
      }
      this.hdk = nextHdk;
      this.passphraseState = passphraseState;
      this.deviceId = deviceId;
      this.connectId = connectId;
      // _resetUnlockedSession() above dropped the in-flight restore promise.
      // Seal it so the next sign's init() does not re-read storage and apply
      // a session this unlock already replaced. cleanUp() clears the seal.
      this.sessionStatePromise = Promise.resolve();
      return 'just unlocked';
    } catch (e) {
      // Discovery or a later device failure must not leave the previous
      // xpub, ids, or passphrase state looking unlocked.
      await this._resetUnlockedSession();
      throw toError(e);
    } finally {
      this.pendingConnectId = null;
    }
  }

  setAccountToUnlock(index: string): void {
    this.unlockedAccount = parseInt(index, 10);
  }

  addAccounts(n = 1): Promise<any> {
    return new Promise((resolve, reject) => {
      this.unlock()
        .then((_) => {
          const from = this.unlockedAccount;
          const to = from + n;

          for (let i = from; i < to; i++) {
            const address = this._addressFromIndex(pathBase, i);
            const checksummedAddress = toChecksumAddress(address);
            if (
              !this.accounts.some(
                (a) => a.toLowerCase() === address.toLowerCase()
              )
            ) {
              this.accounts.push(address);
            }
            this.paths[checksummedAddress] = i;
            this.accountDetails[checksummedAddress] = {
              hdPath: `${this.hdPath}/${i}`,
              hdPathType: LedgerHDPathType.BIP44,
              hdPathBasePublicKey: this.getPathBasePublicKey(),
              passphraseState: this.passphraseState,
              index: i,
            };
            this.page = 0;
          }
          resolve(this.accounts);
        })
        .catch((e) => {
          reject(e);
          return;
        });
    });
  }

  getFirstPage(): Promise<any> {
    this.page = 0;
    return this.__getPage(1);
  }

  getNextPage(): Promise<any> {
    return this.__getPage(1);
  }

  getPreviousPage(): Promise<any> {
    return this.__getPage(-1);
  }
  getAddresses(start: number, end: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.unlock()
        .then((_) => {
          const from = start;
          const to = end;

          const accounts: any[] = [];

          for (let i = from; i < to; i++) {
            const address = this._addressFromIndex(pathBase, i);
            accounts.push({
              address,
              balance: null,
              index: i + 1,
            });
            this.paths[toChecksumAddress(address)] = i;
          }
          resolve(accounts);
        })
        .catch((e) => {
          reject(e);
          return;
        });
    });
  }
  __getPage(increment: number): Promise<any> {
    this.page += increment;

    if (this.page <= 0) {
      this.page = 1;
    }

    return new Promise((resolve, reject) => {
      this.unlock()
        .then((_) => {
          const from = (this.page - 1) * this.perPage;
          const to = from + this.perPage;

          const accounts: any[] = [];

          for (let i = from; i < to; i++) {
            const address = this._addressFromIndex(pathBase, i);
            accounts.push({
              address,
              balance: null,
              index: i + 1,
            });
            this.paths[toChecksumAddress(address)] = i;
          }
          resolve(accounts);
        })
        .catch((e) => {
          reject(e);
          return;
        });
    });
  }

  getAccounts(): Promise<string[]> {
    return Promise.resolve(this.accounts.slice());
  }

  removeAccount(address: string): void {
    if (
      !this.accounts.map((a) => a.toLowerCase()).includes(address.toLowerCase())
    ) {
      throw new Error(`Address ${address} not found in this keyring`);
    }
    this.accounts = this.accounts.filter(
      (a) => a.toLowerCase() !== address.toLowerCase()
    );
    const checksummedAddress = toChecksumAddress(address);
    delete this.accountDetails[checksummedAddress];
    delete this.paths[checksummedAddress];
  }

  private async _unlockForSigning(
    address: string,
    cancellationVersion: number
  ) {
    const checkCancelled = () => {
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('OneKey signing cancelled');
      }
    };
    let status = await this.unlock();
    checkCancelled();
    const index = this.indexFromAddress(address);
    if (!isSameAddress(this._addressFromIndex(pathBase, index), address)) {
      this.hdk = new HDKey();
      // Let the user pick the wallet again instead of resuming the same one.
      this.forceWalletSelectionOnUnlock = true;
      status = await this.unlock();
      checkCancelled();
      if (!isSameAddress(this._addressFromIndex(pathBase, index), address)) {
        throw new Error(t('background.keyring.onekey.walletAddressMismatch'));
      }
    }
    return status;
  }

  // tx is an instance of the ethereumjs-transaction class.
  signTransaction(address: string, tx: TypedTransaction): Promise<any> {
    this.pendingWorkCancelled = false;
    this.pendingSignings += 1;
    const cancellationVersion = this.cancellationVersion;
    return new Promise((resolve, reject) => {
      this._unlockForSigning(address, cancellationVersion)
        .then((status) => {
          setTimeout(
            (_) => {
              if (cancellationVersion !== this.cancellationVersion) {
                reject(new Error('OneKey signing cancelled'));
                return;
              }
              this._signTransaction(
                address,
                Number(tx.common.chainId()),
                tx,
                (payload) => {
                  // Because tx will be immutable, first get a plain javascript object that
                  // represents the transaction. Using txData here as it aligns with the
                  // nomenclature of ethereumjs/tx.
                  const txData = tx.toJSON();
                  // The fromTxData utility expects a type to support transactions with a type other than 0
                  txData.type = `0x${tx.type.toString(16)}`;
                  // The fromTxData utility expects v,r and s to be hex prefixed
                  txData.v = addHexPrefix(payload.v);
                  txData.r = addHexPrefix(payload.r);
                  txData.s = addHexPrefix(payload.s);
                  // Adopt the 'common' option from the original transaction and set the
                  // returned object to be frozen if the original is frozen.
                  return TransactionFactory.fromTxData(txData, {
                    common: tx.common,
                    freeze: Object.isFrozen(tx),
                  });
                }
              )
                .then(resolve)
                .catch((e) => reject(toError(e)));

              // This is necessary to avoid popup collision
              // between the unlock & sign trezor popups
            },
            status === 'just unlocked' ? DELAY_BETWEEN_POPUPS : 0
          );
        })
        .catch((e) => {
          reject(toError(e));
          return;
        });
    }).finally(() => {
      this.pendingSignings -= 1;
    });
  }

  async _signTransaction(
    address,
    chainId,
    tx: TypedTransaction,
    handleSigning
  ) {
    const cancellationVersion = this.cancellationVersion;
    // new-style transaction from @ethereumjs/tx package
    // we can just copy tx.toJSON() for everything except chainId, which must be a number
    const transaction = {
      ...tx.toJSON(),
      chainId,
      to: tx.to?.toString(),
    };
    const params = {
      path: this._pathFromAddress(address),
      passphraseState: this.passphraseState,
      useEmptyPassphrase: this._isEmptyPassphrase(this.passphraseState),
      transaction: transaction as any,
    };
    return this._withPassphraseRecovery(address, params, (p) => {
      const { connectId, deviceId } = this._requireConnectedDevice();
      return this.bridge.evmSignTransaction(connectId, deviceId, p as any);
    }).then((res) => {
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('OneKey signing cancelled');
      }
      if (res.success) {
        const newOrMutatedTx: TypedTransaction = handleSigning(res.payload);
        const addressSignedWith = toChecksumAddress(
          addHexPrefix(newOrMutatedTx.getSenderAddress().toString())
        );
        const correctAddress = toChecksumAddress(address);
        if (addressSignedWith !== correctAddress) {
          throw new Error('signature doesnt match the right address');
        }

        return newOrMutatedTx;
      } else {
        throw toError(res.payload);
      }
    });
  }

  signMessage(withAccount: string, data: string): Promise<any> {
    return this.signPersonalMessage(withAccount, data);
  }

  // For personal_sign, we need to prefix the message:
  signPersonalMessage(withAccount: string, message: string): Promise<any> {
    this.pendingWorkCancelled = false;
    this.pendingSignings += 1;
    const cancellationVersion = this.cancellationVersion;
    return new Promise((resolve, reject) => {
      this._unlockForSigning(withAccount, cancellationVersion)
        .then((status) => {
          setTimeout(
            (_) => {
              if (cancellationVersion !== this.cancellationVersion) {
                reject(new Error('OneKey signing cancelled'));
                return;
              }
              const params = {
                path: this._pathFromAddress(withAccount),
                messageHex: stripHexPrefix(message),
                passphraseState: this.passphraseState,
                useEmptyPassphrase: this._isEmptyPassphrase(
                  this.passphraseState
                ),
              };
              this._withPassphraseRecovery(withAccount, params, (p) => {
                const { connectId, deviceId } = this._requireConnectedDevice();
                return this.bridge.evmSignMessage(
                  connectId,
                  deviceId,
                  p as any
                );
              })
                .then((response) => {
                  if (cancellationVersion !== this.cancellationVersion) {
                    reject(new Error('OneKey signing cancelled'));
                    return;
                  }
                  if (response.success) {
                    const signature = `0x${response.payload.signature}`;
                    let recovered: string;
                    try {
                      recovered = sigUtil.recoverPersonalSignature({
                        // Recover over the exact bytes sent to the device.
                        data: addHexPrefix(stripHexPrefix(message)),
                        sig: signature,
                      });
                    } catch (e) {
                      this.cleanUp();
                      reject(toError(e));
                      return;
                    }
                    if (!isSameAddress(recovered, withAccount)) {
                      this.cleanUp();
                      reject(
                        new Error('signature doesnt match the right address')
                      );
                      return;
                    }
                    resolve(signature);
                  } else {
                    reject(toError(response.payload));
                    return;
                  }
                })
                .catch((e) => {
                  console.log('Error while trying to sign a message ', e);
                  reject(toError(e));
                  return;
                });
              // This is necessary to avoid popup collision
              // between the unlock & sign trezor popups
            },
            status === 'just unlocked' ? DELAY_BETWEEN_POPUPS : 0
          );
        })
        .catch((e) => {
          console.log('Error while trying to sign a message ', e);
          reject(toError(e));
          return;
        });
    }).finally(() => {
      this.pendingSignings -= 1;
    });
  }

  async signTypedData(address, data, opts) {
    switch (opts.version) {
      case 'V1':
        return this.signTypedData_v1(address, data, opts);
      case 'V3':
        return this.signTypedData_v3_v4(address, data, opts);
      case 'V4':
        return this.signTypedData_v3_v4(address, data, opts);
      default:
        return this.signTypedData_v1(address, data, opts);
    }
  }

  signTypedData_v1(address, typedData, opts = {}) {
    // Waiting on trezor to enable this
    throw new Error('Not supported on this device');
  }

  // personal_signTypedData, signs data along with the schema
  signTypedData_v3_v4(
    address,
    typedData,
    opts: { version?: 'V3' | 'V4' } = {}
  ) {
    this.pendingWorkCancelled = false;
    this.pendingSignings += 1;
    const cancellationVersion = this.cancellationVersion;
    return new Promise((resolve, reject) => {
      const isV4 = opts.version === 'V4';
      const {
        domain,
        types,
        primaryType,
        message,
      } = sigUtil.TypedDataUtils.sanitizeData(typedData);
      const domainSeparatorHex = sigUtil.TypedDataUtils.hashStruct(
        'EIP712Domain',
        domain,
        types,
        isV4
      ).toString('hex');
      const hashStructMessageHex = sigUtil.TypedDataUtils.hashStruct(
        primaryType as string,
        message,
        types,
        isV4
      ).toString('hex');
      this._unlockForSigning(address, cancellationVersion)
        .then((status) => {
          setTimeout(
            (_) => {
              if (cancellationVersion !== this.cancellationVersion) {
                reject(new Error('OneKey signing cancelled'));
                return;
              }
              try {
                const params = {
                  path: this._pathFromAddress(address),
                  data: typedData,
                  passphraseState: this.passphraseState,
                  useEmptyPassphrase: this._isEmptyPassphrase(
                    this.passphraseState
                  ),
                  metamaskV4Compat: isV4,
                  domainHash: domainSeparatorHex,
                  messageHash: hashStructMessageHex,
                  chainId: domain.chainId ? Number(domain.chainId) : undefined,
                };
                this._withPassphraseRecovery(address, params, (p) => {
                  const {
                    connectId,
                    deviceId,
                  } = this._requireConnectedDevice();
                  return this.bridge.evmSignTypedData(
                    connectId,
                    deviceId,
                    p as any
                  );
                })
                  .then((response) => {
                    if (cancellationVersion !== this.cancellationVersion) {
                      reject(new Error('OneKey signing cancelled'));
                      return;
                    }
                    if (response.success) {
                      const signature = `0x${response.payload.signature}`;
                      let recovered: string;
                      try {
                        recovered = isV4
                          ? sigUtil.recoverTypedSignature_v4({
                              data: typedData,
                              sig: signature,
                            })
                          : sigUtil.recoverTypedSignature({
                              data: typedData,
                              sig: signature,
                            });
                      } catch (e) {
                        this.cleanUp();
                        reject(toError(e));
                        return;
                      }
                      if (!isSameAddress(recovered, address)) {
                        this.cleanUp();
                        reject(
                          new Error('signature doesnt match the right address')
                        );
                        return;
                      }
                      resolve(signature);
                    } else {
                      let code =
                        (response.payload && response.payload.code) || '';
                      const message =
                        (response.payload && response.payload.error) || '';
                      let errorMsg =
                        (response.payload && response.payload.error) ||
                        'Unknown error';

                      let errorUrl = '';
                      if (message.includes('EIP712Domain')) {
                        code = 'EIP712_DOMAIN_NOT_SUPPORT';
                      } else if (message.includes('EIP712')) {
                        code = 'EIP712_BLIND_SIGN_DISABLED';
                        errorUrl =
                          'https://help.onekey.so/hc/zh-cn/articles/4406637762959';
                      }
                      if (code === 'Failure_UnexpectedMessage') {
                        code = 'EIP712_FIRMWARE_NOT_SUPPORT';
                        errorMsg = 'Not supported on this device';
                      }

                      const error =
                        typeof code === 'string' && code.startsWith('EIP712_')
                          ? Object.assign(
                              new Error(JSON.stringify({ code, errorMsg })),
                              { code: response.payload.code }
                            )
                          : toError(response.payload);
                      reject(error);
                      return;
                    }
                  })
                  .catch((e) => {
                    console.log('Error while trying to sign a message ', e);
                    reject(toError(e));
                    return;
                  });
              } catch (e) {
                reject(toError(e));
                return;
              }
              // This is necessary to avoid popup collision
              // between the unlock & sign trezor popups
            },
            status === 'just unlocked' ? DELAY_BETWEEN_POPUPS : 0
          );
        })
        .catch((e) => {
          console.log('Error while trying to sign a message ', e);
          reject(toError(e));
          return;
        });
    }).finally(() => {
      this.pendingSignings -= 1;
    });
  }

  exportAccount(): Promise<any> {
    return Promise.reject(new Error('Not supported on this device'));
  }

  async forgetDevice(): Promise<void> {
    this.cancellationVersion += 1;
    this.accounts = [];
    this.page = 0;
    this.unlockedAccount = 0;
    this.paths = {};
    this.accountDetails = {};
    this.passphraseStateCleared = false;
    await this.cleanUp();
  }

  /* PRIVATE METHODS */

  _normalize(buf: Buffer): string {
    return bufferToHex(buf);
  }

  // eslint-disable-next-line no-shadow
  _addressFromIndex(pathBase: string, i: number): string {
    const dkey = this.hdk.derive(`${pathBase}/${i}`);
    const address = bufferToHex(publicToAddress(dkey.publicKey, true));
    return toChecksumAddress(address);
  }

  _pathFromAddress(address: string): string {
    return `${this.hdPath}/${this.indexFromAddress(address)}`;
  }

  indexFromAddress(address: string) {
    const checksummedAddress = toChecksumAddress(address);
    let index =
      this.paths[checksummedAddress] ??
      this.accountDetails[checksummedAddress]?.index;

    if (typeof index === 'undefined') {
      for (let i = 0; i < MAX_INDEX; i++) {
        if (checksummedAddress === this._addressFromIndex(pathBase, i)) {
          index = i;
          break;
        }
      }
    }

    if (typeof index === 'undefined') {
      throw new Error('Unknown address');
    }
    return index;
  }

  async getCurrentAccounts() {
    await this.unlock();
    const addresses = await this.getAccounts();
    const currentPublicKey = this.getPathBasePublicKey();
    const accounts: Account[] = [];

    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      await this._fixAccountDetail(address);

      const detail = this.accountDetails[toChecksumAddress(address)];

      if (detail?.hdPathBasePublicKey !== currentPublicKey) {
        continue;
      }

      try {
        const account = {
          address,
          index: this.indexFromAddress(address) + 1,
        };
        accounts.push(account);
      } catch (e) {
        console.log('address not found', address);
      }
    }

    return accounts;
  }

  private getPathBasePublicKey() {
    return this.hdk.publicKey.toString('hex');
  }

  private async _fixAccountDetail(address: string) {
    const checksummedAddress = toChecksumAddress(address);
    const detail = this.accountDetails[checksummedAddress];

    // The detail is already fixed
    if (detail?.hdPathBasePublicKey && detail.hdPath) {
      return;
    }

    let addressInDevice;
    let index;

    try {
      index = this.indexFromAddress(address);
      addressInDevice = this._addressFromIndex(pathBase, index);
    } catch (e) {
      console.log('address not found', address);
    }

    if (!addressInDevice || !isSameAddress(address, addressInDevice)) {
      return;
    }

    this.accountDetails[checksummedAddress] = {
      ...detail,
      index,
      hdPath: this._pathFromAddress(address),
      hdPathType: LedgerHDPathType.BIP44,
      hdPathBasePublicKey: this.getPathBasePublicKey(),
    };
  }

  /**
   * SDK 1.2.7 - 1.2.10 `openWalletSession({ mode: 'select-hidden' })` still reports
   * walletType "hidden" when the user enters an empty passphrase on a Pro 2,
   * and the passphraseState is the standard wallet's btc_test_address. Compare
   * that identity with a useEmptyPassphrase probe and, if they match, treat the
   * session as the standard wallet so the id is never persisted. The probe runs
   * only for an ambiguous V2 session (hidden type + non-empty state). Skip it
   * on attach-PIN sessions because it would request an extra Main PIN. Only
   * the legacy resume path passes the pre-session unlockedAttachPin flag;
   * a newly opened session must refresh status before skipping the probe.
   * A failed probe keeps the hidden id so import can still proceed.
   */
  private async _resolvePassphraseStateForImport({
    connectId,
    protocol,
    walletType,
    passphraseState,
    unlockedAttachPin,
    cancellationVersion,
  }: {
    connectId: string;
    protocol?: string;
    walletType?: 'standard' | 'hidden';
    passphraseState?: string | null;
    unlockedAttachPin?: boolean | null;
    cancellationVersion: number;
  }): Promise<string | undefined> {
    if (walletType === 'standard') {
      return undefined;
    }
    const imported = passphraseState || undefined;
    if (this._isEmptyPassphrase(imported)) {
      return undefined;
    }
    if (protocol !== 'V2' || unlockedAttachPin === true) {
      return imported;
    }
    try {
      const state = await this.bridge.getDeviceState(connectId);
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('OneKey signing cancelled');
      }
      if (!state.success) {
        throw toError(state.payload);
      }
      if (state.success && state.payload.status?.unlockedAttachPin === true) {
        return imported;
      }
    } catch (e) {
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('OneKey signing cancelled');
      }
      const error = toError(e);
      if (
        ['802', '803', '822', '107', '109'].includes(
          String((error as any).code)
        ) ||
        /action cancelled/i.test(error.message)
      ) {
        throw error;
      }
      // A non-cancel status refresh failure still allows the probe.
    }
    const standardIdentity = await this._getStandardWalletIdentity(
      connectId,
      cancellationVersion
    );
    if (standardIdentity && standardIdentity === imported) {
      return undefined;
    }
    return imported;
  }

  private async _getStandardWalletIdentity(
    connectId: string,
    cancellationVersion: number
  ): Promise<string | undefined> {
    try {
      const result = await this.bridge.getPassphraseState(connectId, {
        useEmptyPassphrase: true,
      });
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('OneKey signing cancelled');
      }
      if (!result.success) {
        throw toError(result.payload);
      }
      if (
        result?.success &&
        typeof result.payload === 'string' &&
        result.payload
      ) {
        return result.payload;
      }
    } catch (e) {
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('OneKey signing cancelled');
      }
      const error = toError(e);
      if (
        ['802', '803', '822', '107', '109'].includes(
          String((error as any).code)
        ) ||
        /action cancelled/i.test(error.message)
      ) {
        throw error;
      }
      console.log('failed to read OneKey standard wallet identity', e);
    }
    return undefined;
  }

  private _isEmptyPassphrase(passphraseState: string | undefined | null) {
    return (
      passphraseState === null ||
      passphraseState === undefined ||
      passphraseState === ''
    );
  }
}

export default OneKeyKeyring;
