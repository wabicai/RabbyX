const mockWallet = {
  isBooted: jest.fn().mockResolvedValue(true),
  unlockHardwareAccount: jest.fn().mockResolvedValue(undefined),
  requestKeyring: jest.fn().mockResolvedValue(undefined),
  connectHardware: jest.fn(),
  boot: jest.fn(),
};
const mockSetStore = jest.fn();
const mockPush = jest.fn();

jest.mock('@/ui/views/HDManager/index.less', () => ({}));
jest.mock('ui/assets/walletlogo/onekey.svg', () => ({
  ReactComponent: () => null,
}));
jest.mock('@/constant', () => ({
  HARDWARE_KEYRING_TYPES: {
    Ledger: { type: 'Ledger Hardware' },
    Trezor: { type: 'Trezor Hardware' },
    Onekey: { type: 'Onekey Hardware' },
    GridPlus: { type: 'GridPlus Hardware' },
    BitBox02: { type: 'BitBox02 Hardware' },
    ImKey: { type: 'ImKey Hardware' },
    Keystone: { type: 'Keystone Hardware' },
  },
  KEYRING_CLASS: {
    MNEMONIC: 'Mnemonic',
    HARDWARE: {
      ONEKEY: 'Onekey Hardware',
      KEYSTONE: 'Keystone Hardware',
      GRIDPLUS: 'GridPlus Hardware',
    },
  },
  WALLET_BRAND_TYPES: {
    KEYSTONE: 'Keystone',
    IMTOKENOFFLINE: 'imToken Offline',
    COOLWALLET: 'CoolWallet',
    NGRAVEZERO: 'NGRAVE ZERO',
    AIRGAP: 'AirGap',
  },
}));
jest.mock('@/ui/utils', () => ({
  useWallet: () => mockWallet,
}));
jest.mock('@/ui/views/NewUserImport/hooks/useNewUserGuideStore', () => ({
  useNewUserGuideStore: () => ({
    store: { password: 'pw' },
    setStore: mockSetStore,
  }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('react-router-dom', () => ({
  useHistory: () => ({ push: mockPush }),
  useLocation: () => ({ search: '?isLazyImport=1' }),
}));
jest.mock('@/ui/store', () => ({
  useRabbyDispatch: () => ({
    importMnemonics: {
      setField: jest.fn(),
      confirmAllImportingAccountsAsync: jest.fn(),
    },
  }),
}));
jest.mock('@/ui/models/account', () => ({ account: {} }));
jest.mock('antd', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  return {
    Button: ({
      onClick,
      disabled,
      children,
    }: {
      onClick?: () => void;
      disabled?: boolean;
      children?: React.ReactNode;
    }) => React.createElement('button', { onClick, disabled }, children),
    Spin: () => React.createElement('div'),
    message: { error: jest.fn() },
  };
});
jest.mock('@/ui/views/HDManager/utils', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  const HDManagerStateContext = React.createContext({});
  const HDManagerStateProvider = ({
    children,
    keyring,
    keyringId,
    isLazyImport,
  }: {
    children?: React.ReactNode;
    keyring: string;
    keyringId: number | null;
    isLazyImport?: boolean;
  }) =>
    React.createElement(
      HDManagerStateContext.Provider,
      {
        value: {
          currentAccounts: [],
          selectedAccounts: [{ address: '0xabc', index: 1, aliasName: '' }],
          getCurrentAccounts: jest.fn().mockResolvedValue(undefined),
          isLazyImport,
          createTask: (task: () => unknown) => task(),
          keyring,
          keyringId,
        },
      },
      children
    );
  return { HDManagerStateContext, HDManagerStateProvider };
});
jest.mock('@/ui/views/HDManager/LedgerManager', () => ({
  LedgerManager: () => null,
}));
jest.mock('@/ui/views/HDManager/OnekeyManager', () => ({
  OneKeyManager: () => null,
}));
jest.mock('@/ui/views/HDManager/TrezorManager', () => ({
  TrezorManager: () => null,
}));
jest.mock('@/ui/views/HDManager/MnemonicManager', () => ({
  MnemonicManager: () => null,
}));
jest.mock('@/ui/views/HDManager/GridPlusManager', () => ({
  GridPlusManager: () => null,
}));
jest.mock('@/ui/views/HDManager/QRCodeManager', () => ({
  QRCodeManager: () => null,
}));
jest.mock('@/ui/views/HDManager/BitBox02Manager', () => ({
  BitBox02Manager: () => null,
}));
jest.mock('@/ui/views/HDManager/ImKeyManager', () => ({
  ImKeyManager: () => null,
}));

import React from 'react';
import ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { HDManager } from '@/ui/views/HDManager/HDManager';

const ONEKEY = 'Onekey Hardware';

function cleanUpCalls() {
  return mockWallet.requestKeyring.mock.calls.filter(
    (call) => call[1] === 'cleanUp'
  );
}

describe('HDManager OneKey cleanup ownership', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWallet.isBooted.mockResolvedValue(true);
    mockWallet.unlockHardwareAccount.mockResolvedValue(undefined);
    mockWallet.requestKeyring.mockResolvedValue(undefined);
    jest.spyOn(window, 'close').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    ReactDOM.unmountComponentAtNode(container);
    container.remove();
    jest.restoreAllMocks();
  });

  async function mount() {
    await act(async () => {
      ReactDOM.render(
        React.createElement(HDManager, {
          keyring: ONEKEY,
          keyringId: 7,
          brand: ONEKEY,
        }),
        container
      );
    });
  }

  it('cleans up on unmount before a OneKey import', async () => {
    await mount();
    await act(async () => {
      ReactDOM.unmountComponentAtNode(container);
    });
    expect(cleanUpCalls()).toEqual([[ONEKEY, 'cleanUp', 7, true]]);
  });

  it('releases unmount cleanup after a successful OneKey import', async () => {
    await mount();
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockWallet.unlockHardwareAccount).toHaveBeenCalledWith(
      ONEKEY,
      [0],
      7
    );
    expect(mockSetStore).toHaveBeenCalledWith({ clearKeyringId: undefined });
    expect(cleanUpCalls()).toEqual([]);

    await act(async () => {
      ReactDOM.unmountComponentAtNode(container);
    });
    expect(cleanUpCalls()).toEqual([]);
  });
});
