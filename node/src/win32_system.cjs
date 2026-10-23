/**
 * Windows system directory and file security, without the process environment.
 *
 * kernel32.dll and advapi32.dll are KnownDLLs. Loading them by name returns
 * the module already mapped into this process. It does not search the working
 * directory and it does not read SystemRoot.
 *
 * GetSystemDirectoryW is the process system directory. HKLM
 * SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRoot is the install
 * directory. The caller fails closed unless both name the same System32.
 *
 * File owner and DACL come from GetNamedSecurityInfoW. The current user's
 * SID is TokenUser from GetTokenInformation on this process token.
 * No script host is started.
 */
'use strict';

const koffi = require('koffi');

const RRF_RT_REG_SZ = 0x00000002;
const RRF_SUBKEY_WOW6464KEY = 0x00010000;
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const SDDL_REVISION_1 = 1;
const TOKEN_QUERY = 0x0008;
const TokenUser = 1;
const SYSTEM_ROOT_KEY = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

const TokenUserInfo = koffi.struct('TokenUserInfo', {
  Sid: 'void *',
  Attributes: 'uint32',
});

let bound;

function hklm() {
  // HKEY_LOCAL_MACHINE is (ULONG_PTR)(LONG)0x80000002, sign-extended on 64-bit.
  if (process.arch === 'x64' || process.arch === 'arm64') return 0xFFFFFFFF80000002n;
  return 0x80000002;
}

function bind() {
  if (bound) return bound;
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  bound = {
    GetSystemDirectoryW: kernel32.func('uint32 __stdcall GetSystemDirectoryW(uint16_t *lpBuffer, uint32 uSize)'),
    GetCurrentProcess: kernel32.func('void * __stdcall GetCurrentProcess()'),
    CloseHandle: kernel32.func('int32 __stdcall CloseHandle(void *hObject)'),
    LocalFree: kernel32.func('void * __stdcall LocalFree(void *hMem)'),
    lstrlenW: kernel32.func('int32 __stdcall lstrlenW(void *lpString)'),
    // koffi.decode(ptr, 'str16') access-violates on a LocalAlloc wide string.
    RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(_Out_ uint8_t *Destination, void *Source, uintptr_t Length)'),
    OpenProcessToken: advapi32.func(
      'int32 __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)',
    ),
    GetTokenInformation: advapi32.func(
      'int32 __stdcall GetTokenInformation(void *TokenHandle, int32 TokenInformationClass, void *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)',
    ),
    RegGetValueW: advapi32.func(
      'int32 __stdcall RegGetValueW(uintptr_t hkey, str16 lpSubKey, str16 lpValue, uint32 dwFlags, _Out_ uint32 *pdwType, uint16_t *pvData, _Inout_ uint32 *pcbData)',
    ),
    GetNamedSecurityInfoW: advapi32.func(
      'uint32 __stdcall GetNamedSecurityInfoW(str16 pObjectName, int32 ObjectType, uint32 SecurityInfo, _Out_ void **ppsidOwner, _Out_ void **ppsidGroup, _Out_ void **ppDacl, _Out_ void **ppSacl, _Out_ void **ppSecurityDescriptor)',
    ),
    ConvertSidToStringSidW: advapi32.func(
      'int32 __stdcall ConvertSidToStringSidW(void *Sid, _Out_ void **StringSid)',
    ),
    ConvertSecurityDescriptorToStringSecurityDescriptorW: advapi32.func(
      'int32 __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *SecurityDescriptor, uint32 RequestedStringSDRevision, uint32 SecurityInformation, _Out_ void **StringSecurityDescriptor, _Out_ uint32 *StringSecurityDescriptorLen)',
    ),
  };
  return bound;
}

function utf16(buf, bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 2) return '';
  const chars = Math.floor(n / 2);
  const text = buf.toString('utf16le', 0, chars * 2);
  return text.replace(/\0+$/, '');
}

function getSystemDirectory() {
  const fn = bind();
  const buf = Buffer.alloc(520);
  const n = fn.GetSystemDirectoryW(buf, 260);
  if (!n || n >= 260) throw new Error('datadir_acl:system32');
  const text = buf.toString('utf16le', 0, n * 2).replace(/\0+$/, '');
  if (!text) throw new Error('datadir_acl:system32');
  return text;
}

function readSystemRoot() {
  const fn = bind();
  const buf = Buffer.alloc(1024);
  const type = [0];
  const bytes = [buf.length];
  const status = fn.RegGetValueW(
    hklm(),
    SYSTEM_ROOT_KEY,
    'SystemRoot',
    RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
    type,
    buf,
    bytes,
  );
  if (status !== 0) throw new Error('datadir_acl:system32');
  const text = utf16(buf, bytes[0]);
  if (!text) throw new Error('datadir_acl:system32');
  return text;
}

function localString(fn, ptr) {
  try {
    if (!ptr) return '';
    const n = fn.lstrlenW(ptr);
    if (!Number.isInteger(n) || n < 0 || n > 65536) return '';
    const raw = Buffer.alloc((n + 1) * 2);
    fn.RtlMoveMemory(raw, ptr, (n + 1) * 2);
    return raw.toString('utf16le', 0, n * 2);
  } finally {
    fn.LocalFree(ptr);
  }
}

function readUserSid() {
  const fn = bind();
  const token = [null];
  if (!fn.OpenProcessToken(fn.GetCurrentProcess(), TOKEN_QUERY, token) || !token[0]) {
    throw new Error('datadir_acl:token');
  }
  const sidOut = [null];
  try {
    const needed = [0];
    fn.GetTokenInformation(token[0], TokenUser, null, 0, needed);
    const size = needed[0];
    if (!size || size > 4096) throw new Error('datadir_acl:token');
    const buf = Buffer.alloc(size);
    const got = [0];
    if (!fn.GetTokenInformation(token[0], TokenUser, buf, size, got)) {
      throw new Error('datadir_acl:token');
    }
    const user = koffi.decode(buf, TokenUserInfo);
    if (!user || !user.Sid) throw new Error('datadir_acl:token');
    if (!fn.ConvertSidToStringSidW(user.Sid, sidOut) || !sidOut[0]) throw new Error('datadir_acl:token');
    const text = localString(fn, sidOut[0]);
    sidOut[0] = null;
    if (!/^S-1-\d+(?:-\d+)+$/i.test(text)) throw new Error('datadir_acl:token');
    return text;
  } finally {
    if (sidOut[0]) fn.LocalFree(sidOut[0]);
    fn.CloseHandle(token[0]);
  }
}

function readSecurity(filePath) {
  const fn = bind();
  const owner = [null];
  const group = [null];
  const dacl = [null];
  const sacl = [null];
  const sd = [null];
  const rc = fn.GetNamedSecurityInfoW(
    String(filePath),
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    owner,
    group,
    dacl,
    sacl,
    sd,
  );
  if (rc !== 0 || !owner[0] || !sd[0]) throw new Error('datadir_acl:acl');
  const sidOut = [null];
  const sddlOut = [null];
  const len = [0];
  try {
    if (!fn.ConvertSidToStringSidW(owner[0], sidOut) || !sidOut[0]) throw new Error('datadir_acl:acl');
    const ownerSid = localString(fn, sidOut[0]);
    sidOut[0] = null;
    if (!fn.ConvertSecurityDescriptorToStringSecurityDescriptorW(
      sd[0],
      SDDL_REVISION_1,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      sddlOut,
      len,
    ) || !sddlOut[0]) throw new Error('datadir_acl:acl');
    const sddl = localString(fn, sddlOut[0]);
    sddlOut[0] = null;
    if (!ownerSid || !sddl) throw new Error('datadir_acl:acl');
    return { owner: ownerSid, sddl };
  } finally {
    if (sidOut[0]) fn.LocalFree(sidOut[0]);
    if (sddlOut[0]) fn.LocalFree(sddlOut[0]);
    if (sd[0]) fn.LocalFree(sd[0]);
  }
}

module.exports = {
  getSystemDirectory,
  readSystemRoot,
  readUserSid,
  readSecurity,
};
