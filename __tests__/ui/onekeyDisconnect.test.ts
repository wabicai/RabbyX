import { HardwareErrorCode } from '@onekeyfe/hd-shared';
import { isOneKeyDisconnectError } from '@/ui/utils/onekey';

describe('OneKey disconnect error helper (C2)', () => {
  test.each([
    ['105: Device not found', true],
    ['901: Device not found or needs WebUSB permission', true],
    ['107: OneKey connection was interrupted.', true],
    ['109: OneKey connection was interrupted.', true],
    ['No OneKey Device found', true],
    ['DISCONNECTED', true],
    [{ code: HardwareErrorCode.DeviceNotFound }, true],
    [{ code: HardwareErrorCode.WebDeviceNotFoundOrNeedsPermission }, true],
    [{ code: HardwareErrorCode.DeviceInterruptedFromOutside }, true],
    [{ code: HardwareErrorCode.DeviceInterruptedFromUser }, true],
    [{ errorCode: '105' }, true],
    [Object.assign(new Error('raw error'), { code: 109 }), true],
    [new Error('105: Device not found'), true],
    ['802: Operation cancelled', false],
    ['113: Passphrase is turned off', false],
    [{ code: 802, message: 'Operation cancelled' }, false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('isOneKeyDisconnectError(%p) === %s', (input, expected) => {
    expect(isOneKeyDisconnectError(input)).toBe(expected);
  });
});
