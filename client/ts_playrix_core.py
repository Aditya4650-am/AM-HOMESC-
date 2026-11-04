from __future__ import annotations
"""
ts_township_core.py
===================
Consolidated Township FetchCity core (Playrix custom AES + 0x54/0x79 decoders + GZIP).

Standalone (no Django, no pytz). Drop in your project, then:

    from ts_township_core import fetch_city

    xml_bytes, json_meta = fetch_city(
        own_city_id="bddoYnzMZO",      # taken from <AWS cityId="..."/> in LocalInfo.xml
        target_city_id="pWv8ov7W56",   # the friend's city_id you want to fetch
        bver="39.0.3",                 # from <Version version="..."/>
        fver="3903",                   # from <Version FVer="..."/>
        city_ver=0,                    # 0 on first fetch (server returns latest)
    )

`xml_bytes`  -> the friend's complete game XML (already gunzip + 0x54-decoded)
`json_meta`  -> dict with the JSON envelope (without the data field)

KEY FACTS (these were the bugs in twnscript3_9.py):
  1. AES key is b"Wucai6oj0sheiX3p"  (not "WucaisoJ0sheiX3p" — case typo)
  2. FetchCity body cityId MUST be ""  (not your own cityId)
  3. FetchCity does NOT take token in body
  4. URL param cityId MUST be ""
  5. ts-id auth tag (out_dest) is a Playrix-specific GHASH variant — pycryptodome can NOT
     produce it. The code below ports the original C++ aes_xmm/InvMix routines.
"""
import base64
import json
import random
import zlib
from typing import Tuple, Union

import urllib.error
import urllib.request

# AES key (16 bytes, ascii)
TS_AES_KEY = b"Wucai6oj0sheiX3p"

# Township's own API root — used only by `fetch_city` (clone). Live cards go
# through `api_url(endpoint, host)` below, so the Homescapes host can differ.
API_URL = "https://township.playrix.com/api/1/{endpoint}"

# The Homescapes game API host. Playrix serves each title on its own host, so
# this is deliberately NOT shared with Township's API_URL above. It is passed
# in at runtime from the server's HC_GAME_HOST config, so a wrong value is a
# config change, never a rebuild.
DEFAULT_HOST = "homescapes.playrix.com"


def api_url(endpoint: str, host: str = "") -> str:
    """`https://<host>/api/1/<endpoint>` — accepts a bare host or a full origin."""
    h = (host or DEFAULT_HOST).strip().strip("/")
    if not (h.startswith("http://") or h.startswith("https://")):
        h = "https://" + h
    return f"{h.rstrip('/')}/api/1/{endpoint}"


# ============================================================
# ts_utils
# ============================================================
import time
from ctypes import c_int8, c_int16, c_int32, c_int64, c_uint16, c_uint8, c_uint32, c_uint64
from datetime import datetime
from struct import unpack
from typing import Union, List


orda = ord('a')
ordz = ord('z')
ordA = ord('A')
ordZ = ord('Z')
ord0 = ord('0')
ord9 = ord('9')

#######################################################################
# bit mask
#######################################################################

def s8(x: int) -> int: return c_int8(x).value


def s16(x: int) -> int: return c_int16(x).value


def s32(x: int) -> int: return c_int32(x).value


def s64(x: int) -> int: return c_int64(x).value


def u8(x: int) -> int: return c_uint8(x).value


def u16(x: int) -> int: return c_uint16(x).value


def u32(x: int) -> int: return c_uint32(x).value


def u64(x: int) -> int: return c_uint64(x).value


def u128(x: int) -> int: return x & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF

#######################################################################
# SHR
#######################################################################
def RBn(x: int, n: int) -> int:
    x = x >> (n * 8)
    return u8(x)


def RB0(x: int) -> int: return RBn(x, 0)


def RB1(x: int) -> int: return RBn(x, 1)


def RB2(x: int) -> int: return RBn(x, 2)


def RB3(x: int) -> int: return RBn(x, 3)


def ROL8(data, shift):
    size = 8
    shift %= size
    return u8((data << shift)) | u8(data >> (size - shift))


def ROR8(data, shift):
    size = 8
    shift %= size
    return u8((data >> shift)) | u8(data << (size - shift))

#######################################################################
# SHL
#######################################################################
def LBn(x: int, n: int) -> int:
    x = u8(x) << (n * 8)
    return u32(x)


def LB0(x: int) -> int: return LBn(x, 0)


def LB1(x: int) -> int: return LBn(x, 1)


def LB2(x: int) -> int: return LBn(x, 2)


def LB3(x: int) -> int: return LBn(x, 3)


#######################################################################
# merge & shift bit
#######################################################################
def __PAIR__(a: int, b: int) -> int:
    ret = (u32(a) << 32) | u32(b)
    return ret


def __PAIR_R__(a: int, b: int, c) -> int:
    ret = u64(__PAIR__(a, b)) >> c
    return ret


def __PAIR_R1__(a: int, b: int) -> int: return __PAIR_R__(a, b, 1)


def __PAIR_R2__(a: int, b: int) -> int: return __PAIR_R__(a, b, 2)


def __PAIR_R3__(a: int, b: int) -> int: return __PAIR_R__(a, b, 3)


def __PAIR_R4__(a: int, b: int) -> int: return __PAIR_R__(a, b, 4)


def shld(a: int, b: int, c: int):
    s = 32
    c %= s

    _a = a << c
    _b = b << c
    _a |= b >> (s - c)
    _b |= a >> (s - c)
    return u32(_a)


def shrd(a: int, b: int, c: int):
    s = 32
    c %= 32

    _a = a >> c
    _b = b >> c
    _a |= b << (s - c)
    _b |= a << (s - c)
    return u32(_a)


#######################################################################
# SHR
#######################################################################
def sethibyte(a, val): return (u32(a) & 0x00FFFFFF) | LB3(u8(val))


def setlobyte(a, val): return (u32(a) & 0xFFFFFF00) | LB0(u8(val))


def setbyte0(a, val): return (u32(a) & 0xFFFFFF00) | LB0(u8(val))


def setbyte1(a, val): return (u32(a) & 0xFFFF00FF) | LB1(u8(val))


def setbyte2(a, val): return (u32(a) & 0xFF00FFFF) | LB2(u8(val))


def setbyte3(a, val): return (u32(a) & 0x00FFFFFF) | LB3(u8(val))


# #######################################################################
# # Convert Bytes to (1,2,4,8,16) bytes single Integer
# #######################################################################
# def uLEPtr(x: Union[bytes, bytearray], n: int, offset: int) -> int:
#     return int.from_bytes(
#         bytes=x[offset:offset+n],
#         byteorder='little'
#     )
#
#
# # x[offset : offset + 1] to uint8
# def toU8(x: Union[bytes, bytearray], offset: int) -> int: return uLEPtr(x, 1, 0)
#
#
# # x[offset : offset + 2] to uint16
# def toU16(x: Union[bytes, bytearray], offset: int) -> int: return uLEPtr(x, 2, 0)
#
#
# # x[offset : offset + 4] to uint32
# def toU32(x: Union[bytes, bytearray], offset: int) -> int: return uLEPtr(x, 4, 0)
#
#
# # x[offset : offset + 8] to uint64
# def toU64(x: Union[bytes, bytearray], offset: int) -> int: return uLEPtr(x, 8, 0)
#
#
# # x[offset : offset + 16] to uint128
# def toU128(x: Union[bytes, bytearray], offset: int) -> int: return uLEPtr(x, 16, 0)


#######################################################################
# Convert Bytes to (1,2,4,8) bytes Integer List
#######################################################################
def toU8List(x: Union[bytes, bytearray]) -> List[int]:
    return list(unpack('B' * (len(x)), x))


def toU16List(x: Union[bytes, bytearray]) -> List[int]:
    assert len(x) % 2 == 0
    return list(unpack('H' * (len(x)//2), x))


def toU32List(x: Union[bytes, bytearray]) -> List[int]:
    assert len(x) % 4 == 0
    return list(unpack('I' * (len(x)//4), x))


def toU64List(x: Union[bytes, bytearray]) -> List[int]:
    assert len(x) % 8 == 0
    return list(unpack('Q' * (len(x)//8), x))


#######################################################################
# byte swap
#######################################################################
def ReverseU32(n: int) -> int:
    """
        input
            n = 0x11223344
        output
            0x44332211
    """
    ret = 0
    return int.from_bytes(
        bytes=n.to_bytes(length=4, byteorder='little'),
        byteorder='big'
    )


#######################################################################
# dump
#######################################################################
def hex_dump_to_bytes(str_in: str) -> bytearray:
    """
        In
            "58 E2 6F AD F0 DB 6F AD B8 2A 28 A4 B4 2D F5 AC"
        Out
            b"\x58\xE2\x6F\xAD\xF0\xDB\x6F\xAD\xB8\x2A\x28\xA4\xB4\x2D\xF5\xAC")
    """
    s = str_in.replace(' ', '').replace('\n', '')
    return bytearray().fromhex(s)


def hexdump(string: bytes):
    len_str = len(string)

    print('\n{0:6s} | {1:s} | {2:s}'.format(' ', ' '.join(['{0:2X}'.format(i) for i in range(16)]), ''))
    print("-"*6 + '-+-' + '---'*16 + '+-' + '-'*16 + '-')
    for idx in range(0, len_str, 16):
        print('{0:06x} | {1} | {2}'.format(
            idx,
            ' '.join(['{0:02x}'.format(string[i]) if len_str > i else '  ' for i in range(idx, idx+16)]),
            ''.join([chr(string[i]) if chr(string[i]).isprintable() else '.' for i in range(idx, min(len_str,idx+16))])
        ))






# ============================================================
# ts_bytes
# ============================================================
from typing import Union, Optional, NoReturn, List

# (u8/u16/u32/u64 already in scope)


__STR_SIZE__ = 40


class Structure(object):

    def get(self, offset, nbytes) ->int : pass
    def set(self, offset, val, nbytes): pass

    def __len__(self):
        return 0


class bytePtr(object):
    """
        Usage :
            _byte data[0xFF]
    """
    _obj: Optional[Structure] = None
    _size: int = 0
    _offset: int = 0

    def __len__(self):
        return len(self._obj) - self._offset

    def __init__(self, obj, size, offset = 0):
        self._obj = obj
        self._size = size
        self._offset = offset

    def __str__(self):
        return '{0}B +0x{1:x} {2}'.format(self._size, self._offset, self._obj)

    def __getitem__(self, key: int):
        offset = self._offset + key * self._size
        return self._obj.get(offset, self._size)

    def __setitem__(self, key, value):
        offset = self._offset + key * self._size
        self._obj.set(offset, value, self._size)

    @property
    def as_u8(self) -> bytePtr:
        return bytePtr(self._obj, 1, self._offset)

    @property
    def as_u16(self) -> bytePtr:
        return bytePtr(self._obj, 2, self._offset)

    @property
    def as_u32(self) -> bytePtr:
        return bytePtr(self._obj, 4, self._offset)

    @property
    def as_u64(self) -> bytePtr:
        return bytePtr(self._obj, 8, self._offset)

    @property
    def as_u128(self) -> bytePtr:
        return bytePtr(self._obj, 16, self._offset)

    def byte_offset(self, nbytes):
        return bytePtr(self._obj, self._size, self._offset + nbytes)

    def offset(self, nbytes):
        return bytePtr(self._obj, self._size, self._offset + self._size * nbytes)

    def clone(self):
        return bytePtr(self._obj, self._size, self._offset)

    def getBytearray(self, n=0):
        if n <= 0:
            n = self._size
        return self._obj.getBytearray(self._offset, n)

    def data(self) ->bytearray:
        return self._obj.data()

class byteClass(Structure):
    _data: Optional[bytearray] = None
    _count: int = 0

    def __init__(self, data: Union[bytearray, bytes]):
        self._data = bytearray(data) if isinstance(data, bytes) else data
        self._count = len(data) if data else 0

    def __len__(self):
        return self._count

    def __ne__(self, other):
        if not isinstance(other, byteClass):
            return True
        if self._count != other._count:
            return True
        if self._data != other._data:
            return True
        return False

    def __eq__(self, other):
        return not self.__ne__(other)

    def __str__(self):
        if self._count >= __STR_SIZE__:
            return '{0}...'.format(self._data[:__STR_SIZE__-3].hex())
        else:
            return '{0}'.format(self._data.hex())

    @classmethod
    def fromInt128(cls, n):
        t = cls(bytes([0] * 16))
        t.as_u128[0] = n
        return t

    @classmethod
    def fromInt64(cls, n):
        t = cls(bytes([0] * 8))
        t.as_u64[0] = n
        return t

    @classmethod
    def fromInt32(cls, n):
        t = cls(bytes([0] * 4))
        t.as_u32[0] = n
        return t

    @classmethod
    def fromhex(cls, s:str):
        obj = cls(None)
        obj._data = bytearray.fromhex(s)
        obj._count = len(obj._data)
        return obj

    def capacity(self, size):
        self._count = size
        self._data = bytearray([0] * size)

    def get(self, offset, nbytes):
        ret = 0
        for i in range(nbytes-1, -1, -1):
            assert 0 <= offset + i < self._count, "size=0x{0:x} / offset=0x{1:x} / write length=0x{2:x}".format(self._count, offset, nbytes)

            ret = (ret << 8) | self._data[offset + i]
        return ret

    def set(self, offset, val, nbytes):
        for i in range(0, nbytes):
            assert 0 <= offset + i < self._count, "size=0x{0:x} / offset=0x{1:x} / write length=0x{2:x} / value=0x{3:x}".format(self._count, offset, nbytes, val)
            _val = val >> (8 * i)
            self._data[offset + i] = u8(_val)

    def getBytearray(self, offset, n):
        assert 0 <= offset
        assert offset + n < self._count

        return self._data[offset:offset+n]

    def data(self) -> bytearray:
        return self._data

    @property
    def u8(self) -> bytePtr:
        return bytePtr(self, 1)

    @property
    def u16(self) -> bytePtr:
        return bytePtr(self, 2)

    @property
    def u32(self) -> bytePtr:
        return bytePtr(self, 4)

    @property
    def u64(self) -> bytePtr:
        return bytePtr(self, 8)

    @property
    def u128(self) -> bytePtr:
        return bytePtr(self, 16)

    @property
    def as_u8(self) -> bytePtr:
        return bytePtr(self, 1, 0)

    @property
    def as_u16(self) -> bytePtr:
        return bytePtr(self, 2, 0)

    @property
    def as_u32(self) -> bytePtr:
        return bytePtr(self, 4, 0)

    @property
    def as_u64(self) -> bytePtr:
        return bytePtr(self, 8, 0)

    @property
    def as_u128(self) -> bytePtr:
        return bytePtr(self, 16, 0)

    def with_offset_u8(self, offset) -> bytePtr:
        return bytePtr(self, 1, offset)

    def with_offset_u16(self, offset) -> bytePtr:
        return bytePtr(self, 2, offset)

    def with_offset_u32(self, offset) -> bytePtr:
        return bytePtr(self, 4, offset)

    def with_offset_u64(self, offset) -> bytePtr:
        return bytePtr(self, 8, offset)

    def with_offset_u128(self, offset) -> bytePtr:
        return bytePtr(self, 16, offset)


def memcpy(dst:bytePtr, src:bytePtr, n:int):
    assert isinstance(dst, bytePtr)
    assert isinstance(src, bytePtr)

    assert len(dst) >= n
    assert len(src) >= n

    dst = dst.as_u8
    src = src.as_u8

    for i in range(n):
        dst[i] = src[i]

# ============================================================
# ts_aes_data (T,T1..T4,Tb1..Tb3,Rc tables)
# ============================================================
from struct import unpack
from typing import List


def _(a: str) -> List[int]:
    barr = bytes.fromhex(''.join([_.strip() for _ in a if _.strip()]))
    return list(unpack('I' * (len(barr) // 4), barr))


# T / offset=0x02abb3b8 (44807096) / length = 0x00000040 (64)
T: List[int] = _("""
    000000000000201c0000403800006024000080700000a06c0000c0480000e054000000e1000020fd000040d9000060c5000080910000a08d0000
    c0a90000e0b5
""")


# T1 / offset=0x02ac0248 (44827208) / length = 0x00000400 (1024)
T1: List[int] = _("""
    63c6a5637cf8847c77ee99777bf68d7bf2ff0df26bd6bd6b6fdeb16fc59154c5306050300102030167cea9672b567d2bfee719fed7b562d7ab4d
    e6ab76ec9a76ca8f45ca821f9d82c98940c97dfa877dfaef15fa59b2eb59478ec947f0fb0bf0ad41ecadd4b367d4a25ffda2af45eaaf9c23bf9c
    a453f7a472e49672c09b5bc0b775c2b7fde11cfd933dae93264c6a26366c5a363f7e413ff7f502f7cc834fcc34685c34a551f4a5e5d134e5f1f9
    08f171e29371d8ab73d831625331152a3f1504080c04c79552c723466523c39d5ec3183028189637a196050a0f059a2fb59a070e090712243612
    801b9b80e2df3de2ebcd26eb274e6927b27fcdb275ea9f7509121b09831d9e832c58742c1a342e1a1b362d1b6edcb26e5ab4ee5aa05bfba052a4
    f6523b764d3bd6b761d6b37dceb329527b29e3dd3ee32f5e712f8413978453a6f553d1b968d100000000edc12ced20406020fce31ffcb179c8b1
    5bb6ed5b6ad4be6acb8d46cbbe67d9be39724b394a94de4a4c98d44c58b0e858cf854acfd0bb6bd0efc52aefaa4fe5aafbed16fb4386c5434d9a
    d74d3366553385119485458acf45f9e910f9020406027ffe817f50a0f0503c78443c9f25ba9fa84be3a851a2f351a35dfea34080c0408f058a8f
    923fad929d21bc9d38704838f5f104f5bc63dfbcb677c1b6daaf75da2142632110203010ffe51afff3fd0ef3d2bf6dd2cd814ccd0c18140c1326
    3513ecc32fec5fbee15f9735a2974488cc44172e3917c49357c4a755f2a77efc827e3d7a473d64c8ac645dbae75d19322b1973e6957360c0a060
    811998814f9ed14fdca37fdc224466222a547e2a903bab90880b8388468cca46eec729eeb86bd3b814283c14dea779de5ebce25e0b161d0bdbad
    76dbe0db3be0326456323a744e3a0a141e0a4992db49060c0a0624486c245cb8e45cc29f5dc2d3bd6ed3ac43efac62c4a6629139a8919531a495
    e4d337e479f28b79e7d532e7c88b43c8376e59376ddab76d8d018c8dd5b164d54e9cd24ea949e0a96cd8b46c56acfa56f4f307f4eacf25ea65ca
    af657af48e7aae47e9ae08101808ba6fd5ba78f08878254a6f252e5c722e1c38241ca657f1a6b473c7b4c69751c6e8cb23e8dda17cdd74e89c74
    1f3e211f4b96dd4bbd61dcbd8b0d868b8a0f858a70e090703e7c423eb571c4b566ccaa664890d84803060503f6f701f60e1c120e61c2a361356a
    5f3557aef957b969d0b986179186c19958c11d3a271d9e27b99ee1d938e1f8eb13f8982bb3981122331169d2bb69d9a970d98e07898e9433a794
    9b2db69b1e3c221e87159287e9c920e9ce8749ce55aaff5528507828dfa57adf8c038f8ca159f8a1890980890d1a170dbf65dabfe6d731e64284
    c64268d0b8684182c3419929b0992d5a772d0f1e110fb07bcbb054a8fc54bb6dd6bb162c3a16
""")


# Tb1 / offset=0x02ac024b (44827211) / length = 0x00000400 (1024)
Tb1: List[int] = _("""
    637cf8847c77ee99777bf68d7bf2ff0df26bd6bd6b6fdeb16fc59154c5306050300102030167cea9672b567d2bfee719fed7b562d7ab4de6ab76
    ec9a76ca8f45ca821f9d82c98940c97dfa877dfaef15fa59b2eb59478ec947f0fb0bf0ad41ecadd4b367d4a25ffda2af45eaaf9c23bf9ca453f7
    a472e49672c09b5bc0b775c2b7fde11cfd933dae93264c6a26366c5a363f7e413ff7f502f7cc834fcc34685c34a551f4a5e5d134e5f1f908f171
    e29371d8ab73d831625331152a3f1504080c04c79552c723466523c39d5ec3183028189637a196050a0f059a2fb59a070e090712243612801b9b
    80e2df3de2ebcd26eb274e6927b27fcdb275ea9f7509121b09831d9e832c58742c1a342e1a1b362d1b6edcb26e5ab4ee5aa05bfba052a4f6523b
    764d3bd6b761d6b37dceb329527b29e3dd3ee32f5e712f8413978453a6f553d1b968d100000000edc12ced20406020fce31ffcb179c8b15bb6ed
    5b6ad4be6acb8d46cbbe67d9be39724b394a94de4a4c98d44c58b0e858cf854acfd0bb6bd0efc52aefaa4fe5aafbed16fb4386c5434d9ad74d33
    66553385119485458acf45f9e910f9020406027ffe817f50a0f0503c78443c9f25ba9fa84be3a851a2f351a35dfea34080c0408f058a8f923fad
    929d21bc9d38704838f5f104f5bc63dfbcb677c1b6daaf75da2142632110203010ffe51afff3fd0ef3d2bf6dd2cd814ccd0c18140c13263513ec
    c32fec5fbee15f9735a2974488cc44172e3917c49357c4a755f2a77efc827e3d7a473d64c8ac645dbae75d19322b1973e6957360c0a060811998
    814f9ed14fdca37fdc224466222a547e2a903bab90880b8388468cca46eec729eeb86bd3b814283c14dea779de5ebce25e0b161d0bdbad76dbe0
    db3be0326456323a744e3a0a141e0a4992db49060c0a0624486c245cb8e45cc29f5dc2d3bd6ed3ac43efac62c4a6629139a8919531a495e4d337
    e479f28b79e7d532e7c88b43c8376e59376ddab76d8d018c8dd5b164d54e9cd24ea949e0a96cd8b46c56acfa56f4f307f4eacf25ea65caaf657a
    f48e7aae47e9ae08101808ba6fd5ba78f08878254a6f252e5c722e1c38241ca657f1a6b473c7b4c69751c6e8cb23e8dda17cdd74e89c741f3e21
    1f4b96dd4bbd61dcbd8b0d868b8a0f858a70e090703e7c423eb571c4b566ccaa664890d84803060503f6f701f60e1c120e61c2a361356a5f3557
    aef957b969d0b986179186c19958c11d3a271d9e27b99ee1d938e1f8eb13f8982bb3981122331169d2bb69d9a970d98e07898e9433a7949b2db6
    9b1e3c221e87159287e9c920e9ce8749ce55aaff5528507828dfa57adf8c038f8ca159f8a1890980890d1a170dbf65dabfe6d731e64284c64268
    d0b8684182c3419929b0992d5a772d0f1e110fb07bcbb054a8fc54bb6dd6bb162c3a16c6a563
""")


# T2 / offset=0x02ac0648 (44828232) / length = 0x00000400 (1024)
T2: List[int] = _("""
    c6a56363f8847c7cee997777f68d7b7bff0df2f2d6bd6b6bdeb16f6f9154c5c56050303002030101cea96767567d2b2be719fefeb562d7d74de6
    ababec9a76768f45caca1f9d82828940c9c9fa877d7def15fafab2eb59598ec94747fb0bf0f041ecadadb367d4d45ffda2a245eaafaf23bf9c9c
    53f7a4a4e49672729b5bc0c075c2b7b7e11cfdfd3dae93934c6a26266c5a36367e413f3ff502f7f7834fcccc685c343451f4a5a5d134e5e5f908
    f1f1e2937171ab73d8d8625331312a3f1515080c04049552c7c7466523239d5ec3c33028181837a196960a0f05052fb59a9a0e09070724361212
    1b9b8080df3de2e2cd26ebeb4e6927277fcdb2b2ea9f7575121b09091d9e838358742c2c342e1a1a362d1b1bdcb26e6eb4ee5a5a5bfba0a0a4f6
    5252764d3b3bb761d6d67dceb3b3527b2929dd3ee3e35e712f2f13978484a6f55353b968d1d100000000c12ceded40602020e31ffcfc79c8b1b1
    b6ed5b5bd4be6a6a8d46cbcb67d9bebe724b393994de4a4a98d44c4cb0e85858854acfcfbb6bd0d0c52aefef4fe5aaaaed16fbfb86c543439ad7
    4d4d66553333119485858acf4545e910f9f904060202fe817f7fa0f0505078443c3c25ba9f9f4be3a8a8a2f351515dfea3a380c04040058a8f8f
    3fad929221bc9d9d70483838f104f5f563dfbcbc77c1b6b6af75dada4263212120301010e51afffffd0ef3f3bf6dd2d2814ccdcd18140c0c2635
    1313c32fececbee15f5f35a2979788cc44442e3917179357c4c455f2a7a7fc827e7e7a473d3dc8ac6464bae75d5d322b1919e6957373c0a06060
    199881819ed14f4fa37fdcdc44662222547e2a2a3bab90900b8388888cca4646c729eeee6bd3b8b8283c1414a779dedebce25e5e161d0b0bad76
    dbdbdb3be0e064563232744e3a3a141e0a0a92db49490c0a0606486c2424b8e45c5c9f5dc2c2bd6ed3d343efacacc4a6626239a8919131a49595
    d337e4e4f28b7979d532e7e78b43c8c86e593737dab76d6d018c8d8db164d5d59cd24e4e49e0a9a9d8b46c6cacfa5656f307f4f4cf25eaeacaaf
    6565f48e7a7a47e9aeae101808086fd5babaf08878784a6f25255c722e2e38241c1c57f1a6a673c7b4b49751c6c6cb23e8e8a17cdddde89c7474
    3e211f1f96dd4b4b61dcbdbd0d868b8b0f858a8ae09070707c423e3e71c4b5b5ccaa666690d8484806050303f701f6f61c120e0ec2a361616a5f
    3535aef9575769d0b9b9179186869958c1c13a271d1d27b99e9ed938e1e1eb13f8f82bb3989822331111d2bb6969a970d9d907898e8e33a79494
    2db69b9b3c221e1e15928787c920e9e98749ceceaaff555550782828a57adfdf038f8c8c59f8a1a1098089891a170d0d65dabfbfd731e6e684c6
    4242d0b8686882c3414129b099995a772d2d1e110f0f7bcbb0b0a8fc54546dd6bbbb2c3a1616
""")


# Tb2 / offset=0x02ac064a (44828234) / length = 0x00000400 (1024)
Tb2: List[int] = _("""
    6363f8847c7cee997777f68d7b7bff0df2f2d6bd6b6bdeb16f6f9154c5c56050303002030101cea96767567d2b2be719fefeb562d7d74de6abab
    ec9a76768f45caca1f9d82828940c9c9fa877d7def15fafab2eb59598ec94747fb0bf0f041ecadadb367d4d45ffda2a245eaafaf23bf9c9c53f7
    a4a4e49672729b5bc0c075c2b7b7e11cfdfd3dae93934c6a26266c5a36367e413f3ff502f7f7834fcccc685c343451f4a5a5d134e5e5f908f1f1
    e2937171ab73d8d8625331312a3f1515080c04049552c7c7466523239d5ec3c33028181837a196960a0f05052fb59a9a0e090707243612121b9b
    8080df3de2e2cd26ebeb4e6927277fcdb2b2ea9f7575121b09091d9e838358742c2c342e1a1a362d1b1bdcb26e6eb4ee5a5a5bfba0a0a4f65252
    764d3b3bb761d6d67dceb3b3527b2929dd3ee3e35e712f2f13978484a6f55353b968d1d100000000c12ceded40602020e31ffcfc79c8b1b1b6ed
    5b5bd4be6a6a8d46cbcb67d9bebe724b393994de4a4a98d44c4cb0e85858854acfcfbb6bd0d0c52aefef4fe5aaaaed16fbfb86c543439ad74d4d
    66553333119485858acf4545e910f9f904060202fe817f7fa0f0505078443c3c25ba9f9f4be3a8a8a2f351515dfea3a380c04040058a8f8f3fad
    929221bc9d9d70483838f104f5f563dfbcbc77c1b6b6af75dada4263212120301010e51afffffd0ef3f3bf6dd2d2814ccdcd18140c0c26351313
    c32fececbee15f5f35a2979788cc44442e3917179357c4c455f2a7a7fc827e7e7a473d3dc8ac6464bae75d5d322b1919e6957373c0a060601998
    81819ed14f4fa37fdcdc44662222547e2a2a3bab90900b8388888cca4646c729eeee6bd3b8b8283c1414a779dedebce25e5e161d0b0bad76dbdb
    db3be0e064563232744e3a3a141e0a0a92db49490c0a0606486c2424b8e45c5c9f5dc2c2bd6ed3d343efacacc4a6626239a8919131a49595d337
    e4e4f28b7979d532e7e78b43c8c86e593737dab76d6d018c8d8db164d5d59cd24e4e49e0a9a9d8b46c6cacfa5656f307f4f4cf25eaeacaaf6565
    f48e7a7a47e9aeae101808086fd5babaf08878784a6f25255c722e2e38241c1c57f1a6a673c7b4b49751c6c6cb23e8e8a17cdddde89c74743e21
    1f1f96dd4b4b61dcbdbd0d868b8b0f858a8ae09070707c423e3e71c4b5b5ccaa666690d8484806050303f701f6f61c120e0ec2a361616a5f3535
    aef9575769d0b9b9179186869958c1c13a271d1d27b99e9ed938e1e1eb13f8f82bb3989822331111d2bb6969a970d9d907898e8e33a794942db6
    9b9b3c221e1e15928787c920e9e98749ceceaaff555550782828a57adfdf038f8c8c59f8a1a1098089891a170d0d65dabfbfd731e6e684c64242
    d0b8686882c3414129b099995a772d2d1e110f0f7bcbb0b0a8fc54546dd6bbbb2c3a1616a563
""")


# T3 / offset=0x02ac0a48 (44829256) / length = 0x00000400 (1024)
T3: List[int] = _("""
    a56363c6847c7cf8997777ee8d7b7bf60df2f2ffbd6b6bd6b16f6fde54c5c5915030306003010102a96767ce7d2b2b5619fefee762d7d7b5e6ab
    ab4d9a7676ec45caca8f9d82821f40c9c989877d7dfa15fafaefeb5959b2c947478e0bf0f0fbecadad4167d4d4b3fda2a25feaafaf45bf9c9c23
    f7a4a453967272e45bc0c09bc2b7b7751cfdfde1ae93933d6a26264c5a36366c413f3f7e02f7f7f54fcccc835c343468f4a5a55134e5e5d108f1
    f1f9937171e273d8d8ab533131623f15152a0c04040852c7c795652323465ec3c39d28181830a19696370f05050ab59a9a2f0907070e36121224
    9b80801b3de2e2df26ebebcd6927274ecdb2b27f9f7575ea1b0909129e83831d742c2c582e1a1a342d1b1b36b26e6edcee5a5ab4fba0a05bf652
    52a44d3b3b7661d6d6b7ceb3b37d7b2929523ee3e3dd712f2f5e97848413f55353a668d1d1b9000000002cededc1602020401ffcfce3c8b1b179
    ed5b5bb6be6a6ad446cbcb8dd9bebe674b393972de4a4a94d44c4c98e85858b04acfcf856bd0d0bb2aefefc5e5aaaa4f16fbfbedc5434386d74d
    4d9a5533336694858511cf45458a10f9f9e906020204817f7ffef05050a0443c3c78ba9f9f25e3a8a84bf35151a2fea3a35dc04040808a8f8f05
    ad92923fbc9d9d214838387004f5f5f1dfbcbc63c1b6b67775dadaaf63212142301010201affffe50ef3f3fd6dd2d2bf4ccdcd81140c0c183513
    13262fececc3e15f5fbea2979735cc4444883917172e57c4c493f2a7a755827e7efc473d3d7aac6464c8e75d5dba2b191932957373e6a06060c0
    98818119d14f4f9e7fdcdca3662222447e2a2a54ab90903b8388880bca46468c29eeeec7d3b8b86b3c14142879dedea7e25e5ebc1d0b0b1676db
    dbad3be0e0db563232644e3a3a741e0a0a14db4949920a06060c6c242448e45c5cb85dc2c29f6ed3d3bdefacac43a66262c4a8919139a4959531
    37e4e4d38b7979f232e7e7d543c8c88b5937376eb76d6dda8c8d8d0164d5d5b1d24e4e9ce0a9a949b46c6cd8fa5656ac07f4f4f325eaeacfaf65
    65ca8e7a7af4e9aeae4718080810d5baba6f887878f06f25254a722e2e5c241c1c38f1a6a657c7b4b47351c6c69723e8e8cb7cdddda19c7474e8
    211f1f3edd4b4b96dcbdbd61868b8b0d858a8a0f907070e0423e3e7cc4b5b571aa6666ccd84848900503030601f6f6f7120e0e1ca36161c25f35
    356af95757aed0b9b9699186861758c1c199271d1d3ab99e9e2738e1e1d913f8f8ebb398982b33111122bb6969d270d9d9a9898e8e07a7949433
    b69b9b2d221e1e3c9287871520e9e9c949cece87ff5555aa782828507adfdfa58f8c8c03f8a1a15980898909170d0d1adabfbf6531e6e6d7c642
    4284b86868d0c3414182b0999929772d2d5a110f0f1ecbb0b07bfc5454a8d6bbbb6d3a16162c
""")


# Tb3 / offset=0x02ac0a49 (44829257) / length = 0x00000400 (1024)
Tb3: List[int] = _("""
    6363c6847c7cf8997777ee8d7b7bf60df2f2ffbd6b6bd6b16f6fde54c5c5915030306003010102a96767ce7d2b2b5619fefee762d7d7b5e6abab
    4d9a7676ec45caca8f9d82821f40c9c989877d7dfa15fafaefeb5959b2c947478e0bf0f0fbecadad4167d4d4b3fda2a25feaafaf45bf9c9c23f7
    a4a453967272e45bc0c09bc2b7b7751cfdfde1ae93933d6a26264c5a36366c413f3f7e02f7f7f54fcccc835c343468f4a5a55134e5e5d108f1f1
    f9937171e273d8d8ab533131623f15152a0c04040852c7c795652323465ec3c39d28181830a19696370f05050ab59a9a2f0907070e361212249b
    80801b3de2e2df26ebebcd6927274ecdb2b27f9f7575ea1b0909129e83831d742c2c582e1a1a342d1b1b36b26e6edcee5a5ab4fba0a05bf65252
    a44d3b3b7661d6d6b7ceb3b37d7b2929523ee3e3dd712f2f5e97848413f55353a668d1d1b9000000002cededc1602020401ffcfce3c8b1b179ed
    5b5bb6be6a6ad446cbcb8dd9bebe674b393972de4a4a94d44c4c98e85858b04acfcf856bd0d0bb2aefefc5e5aaaa4f16fbfbedc5434386d74d4d
    9a5533336694858511cf45458a10f9f9e906020204817f7ffef05050a0443c3c78ba9f9f25e3a8a84bf35151a2fea3a35dc04040808a8f8f05ad
    92923fbc9d9d214838387004f5f5f1dfbcbc63c1b6b67775dadaaf63212142301010201affffe50ef3f3fd6dd2d2bf4ccdcd81140c0c18351313
    262fececc3e15f5fbea2979735cc4444883917172e57c4c493f2a7a755827e7efc473d3d7aac6464c8e75d5dba2b191932957373e6a06060c098
    818119d14f4f9e7fdcdca3662222447e2a2a54ab90903b8388880bca46468c29eeeec7d3b8b86b3c14142879dedea7e25e5ebc1d0b0b1676dbdb
    ad3be0e0db563232644e3a3a741e0a0a14db4949920a06060c6c242448e45c5cb85dc2c29f6ed3d3bdefacac43a66262c4a8919139a495953137
    e4e4d38b7979f232e7e7d543c8c88b5937376eb76d6dda8c8d8d0164d5d5b1d24e4e9ce0a9a949b46c6cd8fa5656ac07f4f4f325eaeacfaf6565
    ca8e7a7af4e9aeae4718080810d5baba6f887878f06f25254a722e2e5c241c1c38f1a6a657c7b4b47351c6c69723e8e8cb7cdddda19c7474e821
    1f1f3edd4b4b96dcbdbd61868b8b0d858a8a0f907070e0423e3e7cc4b5b571aa6666ccd84848900503030601f6f6f7120e0e1ca36161c25f3535
    6af95757aed0b9b9699186861758c1c199271d1d3ab99e9e2738e1e1d913f8f8ebb398982b33111122bb6969d270d9d9a9898e8e07a7949433b6
    9b9b2d221e1e3c9287871520e9e9c949cece87ff5555aa782828507adfdfa58f8c8c03f8a1a15980898909170d0d1adabfbf6531e6e6d7c64242
    84b86868d0c3414182b0999929772d2d5a110f0f1ecbb0b07bfc5454a8d6bbbb6d3a16162c63
""")


# T4 / offset=0x02ac0e48 (44830280) / length = 0x00000400 (1024)
T4: List[int] = _("""
    6363c6a57c7cf8847777ee997b7bf68df2f2ff0d6b6bd6bd6f6fdeb1c5c5915430306050010102036767cea92b2b567dfefee719d7d7b562abab
    4de67676ec9acaca8f4582821f9dc9c989407d7dfa87fafaef155959b2eb47478ec9f0f0fb0badad41ecd4d4b367a2a25ffdafaf45ea9c9c23bf
    a4a453f77272e496c0c09b5bb7b775c2fdfde11c93933dae26264c6a36366c5a3f3f7e41f7f7f502cccc834f3434685ca5a551f4e5e5d134f1f1
    f9087171e293d8d8ab733131625315152a3f0404080cc7c7955223234665c3c39d5e18183028969637a105050a0f9a9a2fb507070e0912122436
    80801b9be2e2df3debebcd2627274e69b2b27fcd7575ea9f0909121b83831d9e2c2c58741a1a342e1b1b362d6e6edcb25a5ab4eea0a05bfb5252
    a4f63b3b764dd6d6b761b3b37dce2929527be3e3dd3e2f2f5e71848413975353a6f5d1d1b96800000000ededc12c20204060fcfce31fb1b179c8
    5b5bb6ed6a6ad4becbcb8d46bebe67d93939724b4a4a94de4c4c98d45858b0e8cfcf854ad0d0bb6befefc52aaaaa4fe5fbfbed16434386c54d4d
    9ad7333366558585119445458acff9f9e910020204067f7ffe815050a0f03c3c78449f9f25baa8a84be35151a2f3a3a35dfe404080c08f8f058a
    92923fad9d9d21bc38387048f5f5f104bcbc63dfb6b677c1dadaaf752121426310102030ffffe51af3f3fd0ed2d2bf6dcdcd814c0c0c18141313
    2635ececc32f5f5fbee1979735a2444488cc17172e39c4c49357a7a755f27e7efc823d3d7a476464c8ac5d5dbae71919322b7373e6956060c0a0
    818119984f4f9ed1dcdca37f222244662a2a547e90903bab88880b8346468ccaeeeec729b8b86bd31414283cdedea7795e5ebce20b0b161ddbdb
    ad76e0e0db3b323264563a3a744e0a0a141e494992db06060c0a2424486c5c5cb8e4c2c29f5dd3d3bd6eacac43ef6262c4a6919139a8959531a4
    e4e4d3377979f28be7e7d532c8c88b4337376e596d6ddab78d8d018cd5d5b1644e4e9cd2a9a949e06c6cd8b45656acfaf4f4f307eaeacf256565
    caaf7a7af48eaeae47e908081018baba6fd57878f08825254a6f2e2e5c721c1c3824a6a657f1b4b473c7c6c69751e8e8cb23dddda17c7474e89c
    1f1f3e214b4b96ddbdbd61dc8b8b0d868a8a0f857070e0903e3e7c42b5b571c46666ccaa484890d803030605f6f6f7010e0e1c126161c2a33535
    6a5f5757aef9b9b969d086861791c1c199581d1d3a279e9e27b9e1e1d938f8f8eb1398982bb3111122336969d2bbd9d9a9708e8e0789949433a7
    9b9b2db61e1e3c2287871592e9e9c920cece87495555aaff28285078dfdfa57a8c8c038fa1a159f8898909800d0d1a17bfbf65dae6e6d7314242
    84c66868d0b8414182c3999929b02d2d5a770f0f1e11b0b07bcb5454a8fcbbbb6dd616162c3a
""")


# Rc / offset=0x02ac1248 (44831304) / length = 0x00000028 (40)
Rc: List[int] = _("""
    00000001000000020000000400000008000000100000002000000040000000800000001b00000036
""")


# ============================================================
# ts_aes (Playrix custom AES-CTR + GHASH variant)
# ============================================================
from typing import List, NoReturn, Union


# (AES tables already in scope)
# (byteClass/bytePtr/memcpy already in scope)
# (ts_utils helpers already in scope)



def _mm_loadu_si128(mem_addr: bytePtr) -> int:
    return mem_addr.as_u128[0]


def _mm_load_si128(mem_addr: bytePtr) -> int:
    return mem_addr.as_u128[0]


def _mm_store_si128(mem_addr: bytePtr, a: int) -> NoReturn:
    memcpy(mem_addr, byteClass.fromInt128(a).u8, 16)


def _mm_storeu_si128(mem_addr: bytePtr, a: int) -> NoReturn:
    memcpy(mem_addr, byteClass.fromInt128(a).u8, 16)


def _mm_slli_epi64(_val: int, _n: int) -> int:
    a = byteClass.fromInt128(_val)
    a.as_u64[1] <<= _n
    return a.as_u128[0]


def _mm_srli_epi64(_val: int, _n: int) -> int:
    _a = byteClass.fromInt128(_val)
    _a.as_u64[1] >>= _n
    return _a.as_u128[0]


def _mm_xor_si128(_a: int, _b: int) -> int:
    return u128(_a ^ _b)


def _mm_or_si128(_a: int, _b: int) -> int:
    return u128(_a | _b)


def _mm_and_si128(_a: int, _b: int) -> int:
    return u128(_a & _b)


def aes_xmm(_a1: bytePtr):
    """
        ver 7.9.0 : .text:02425EEF aes_encode_xmm
    """

    xmmword_0284FBE0 = 0x00000000FF00000000000000FF000000
    xmmword_0284F970 = 0x0000000000FF00000000000000FF0000
    xmmword_0284FBC0 = 0x000000000000FF00000000000000FF00
    xmmword_0284FBD0 = 0x00000000000000FF00000000000000FF

    a1 = _a1.as_u128

    v3 = _mm_loadu_si128(a1.offset(3))
    _mm_storeu_si128(a1.offset(3), _mm_slli_epi64(v3, 3))

    if a1.offset(22).as_u32[2] or a1.offset(22).as_u32[3]:
        InvMix_1(a1.offset(4), a1.offset(6))

    v6 = _mm_srli_epi64(v3, 5)
    v8 = _mm_srli_epi64(v3, 0x15)
    _mm_storeu_si128(
        a1.offset(4),
        _mm_xor_si128(
            _mm_loadu_si128(a1.offset(4)),
            _mm_or_si128(
                _mm_or_si128(
                    _mm_or_si128(
                        _mm_or_si128(
                            _mm_and_si128(v6, xmmword_0284FBE0),
                            _mm_and_si128(
                                _mm_srli_epi64(v3, 0x25), xmmword_0284FBC0)
                        ),
                        _mm_and_si128(
                            _mm_srli_epi64(v3, 0x35), xmmword_0284FBD0)
                    ),
                    _mm_slli_epi64(
                        _mm_or_si128(
                            _mm_or_si128(
                                _mm_and_si128(v8, xmmword_0284FBD0),
                                _mm_or_si128(
                                    _mm_and_si128(v6, xmmword_0284FBC0),
                                    _mm_slli_epi64(v3, 0x1B)
                                )
                            ),
                            _mm_and_si128(
                                _mm_slli_epi64(v3, 0xB),
                                xmmword_0284F970
                            )
                        ),
                        0x20
                    )
                ),
                _mm_and_si128(v8, xmmword_0284F970)
            )
        )
    )

    InvMix_1(a1.offset(4), a1.offset(6))

    a1.offset(4).as_u128[0] ^= a1.offset(2).as_u128[0]


def InvMix_1(a1: bytePtr, a2: bytePtr):
    """
        ver 7.9.0 : .text:02424E15 sub_2424E15     proc near
    """
    d0, d1, d2, d3 = 0, 0, 0, 0

    u8a1 = a1.as_u8
    u32a1 = a1.as_u32
    u32a2 = a2.as_u32

    for i in range(15, -1, -1):
        idx = (u8a1[i] & 0xF) << 2
        s0 = u32a2[idx + 0] ^ shld(d0, d1, 0x1C)
        s1 = u32a2[idx + 1] ^ T[d3 & 0xF] ^ (d0 >> 4)
        s2 = u32a2[idx + 2] ^ shld(d2, d3, 0x1C)
        s3 = u32a2[idx + 3] ^ shld(d1, d2, 0x1C)

        idx = (u8a1[i] & 0xF0) >> 2
        d0 = u32a2[idx + 1] ^ T[s2 & 0xF] ^ (s1 >> 4)
        d1 = u32a2[idx + 0] ^ shld(s1, s0, 0x1C)
        d2 = u32a2[idx + 3] ^ shld(s0, s3, 0x1C)
        d3 = u32a2[idx + 2] ^ shld(s3, s2, 0x1C)

    u32a1[0] = ReverseU32(d0)
    u32a1[1] = ReverseU32(d1)
    u32a1[2] = ReverseU32(d2)
    u32a1[3] = ReverseU32(d3)

    return d3 >> 16


def InvMix_2(a1: bytePtr, a2: bytePtr, a3: bytePtr, n):
    """
        ver 7.9.0 : .text:024250A3 sub_24250A3
    """
    u8a2 = a2.as_u8
    u8a3 = a3.as_u8

    u32a1 = a1.as_u32
    u32a2 = a2.as_u32

    for _ in range(0, n, 16):
        d0, d1, d2, d3 = 0, 0, 0, 0

        for i in range(15, -1, -1):
            v7 = u8a2[i] ^ u8a3[i]
            idx = (v7 & 0xF) << 2
            s0 = u32a1[idx + 0] ^ shld(d0, d1, 0x1C)
            s1 = u32a1[idx + 1] ^ T[d3 & 0xF] ^ (d0 >> 4)
            s2 = u32a1[idx + 2] ^ shld(d2, d3, 0x1C)
            s3 = u32a1[idx + 3] ^ shld(d1, d2, 0x1C)

            idx = (v7 & 0xF0) >> 2
            d0 = u32a1[idx + 1] ^ T[s2 & 0xF] ^ (s1 >> 4)
            d1 = u32a1[idx + 0] ^ shld(s1, s0, 0x1C)
            d2 = u32a1[idx + 3] ^ shld(s0, s3, 0x1C)
            d3 = u32a1[idx + 2] ^ shld(s3, s2, 0x1C)

        u32a2[0] = ReverseU32(d0)
        u32a2[1] = ReverseU32(d1)
        u32a2[2] = ReverseU32(d2)
        u32a2[3] = ReverseU32(d3)

        u8a3 = u8a3.byte_offset(16)

    return 0


class AES_CTX(object):
    ROUND_MAP = {128: 0x0A, 192: 0x0C, 256: 0x0E}
    _data:byteClass = None

    def __init__(self):
        super(AES_CTX, self).__init__()
        self._data = byteClass(bytearray([0] * 244))

    def __ne__(self, other):
        if not isinstance(other, AES_CTX):
            return True
        if self._data != other._data:
            return True
        return False

    def __eq__(self, other):
        return not self.__ne__(other)

    @classmethod
    def from_bytes(cls, data: bytes):  # for pytest
        assert len(data) == 4 * 60 + 4
        obj = cls()
        obj._data = byteClass(data)
        return obj

    @classmethod
    def from_hex(cls, data: str):  # for pytest
        assert len(data) == 2 * (4 * 60 + 4), "AES_CTX size is 244, hexString(488), but parameter is {}".format(len(data))
        obj = cls().from_bytes(bytes.fromhex(data))
        return obj

    @property
    def rounds(self):
        return self._data.u32[60]

    @rounds.setter
    def rounds(self, val):
        self._data.u32[60] = val

    @property
    def rd_key(self):
        return self._data.u32

    def set_encrypt_key(self, userKey: bytePtr, bits: int):
        """
            ver 7.9.0 : .text:02431A14 sub_2431A14     proc near
        """
        self.rounds = self.ROUND_MAP[bits]
        key32 = userKey.as_u32

        if bits == 0x80:
            for i in range(0, 4):
                self.rd_key[i] = ReverseU32(key32[i])

            for i in range(0, 0x28, 4):
                v6 = self.rd_key[i + 3]
                v4 = LB0(T4[RB3(v6)]) ^ LB1(Tb3[RB0(v6)]) ^ LB2(Tb2[RB1(v6)]) ^ LB3(Tb1[RB2(v6)])
                self.rd_key[i + 4] = self.rd_key[i + 0] ^ v4 ^ Rc[i // 4]
                self.rd_key[i + 5] = self.rd_key[i + 1] ^ self.rd_key[i + 4]
                self.rd_key[i + 6] = self.rd_key[i + 2] ^ self.rd_key[i + 5]
                self.rd_key[i + 7] = self.rd_key[i + 3] ^ self.rd_key[i + 6]

    def single_block_encrypt(self, a1: bytePtr, a2: bytePtr):
        rk_idx = 0
        d0, d1, d2, d3 = 0, 0, 0, 0
        in32 = a1.as_u32
        out32 = a2.as_u32

        def X(a, b, c, d):
            return T1[RB1(a)] ^ T2[RB0(b)] ^ T3[RB3(c)] ^ T4[RB2(d)]

        def O(a, b, c, d):
            return LB3(Tb1[RB3(a)]) | LB2(Tb2[RB2(b)]) | LB1(Tb3[RB1(c)]) | LB0(T4[RB0(d)])

        s0 = self.rd_key[rk_idx + 0] ^ ReverseU32(in32[0])
        s1 = self.rd_key[rk_idx + 1] ^ ReverseU32(in32[1])
        s2 = self.rd_key[rk_idx + 2] ^ ReverseU32(in32[2])
        s3 = self.rd_key[rk_idx + 3] ^ ReverseU32(in32[3])

        for i in range(0, self.rounds // 2):
            rk_idx += 4
            d3 = self.rd_key[rk_idx + 0] ^ X(s2, s3, s0, s1)
            d2 = self.rd_key[rk_idx + 1] ^ X(s3, s0, s1, s2)
            d1 = self.rd_key[rk_idx + 2] ^ X(s0, s1, s2, s3)
            d0 = self.rd_key[rk_idx + 3] ^ X(s1, s2, s3, s0)

            if i + 1 == self.rounds // 2:
                break

            rk_idx += 4
            s0 = self.rd_key[rk_idx + 0] ^ X(d1, d0, d3, d2)
            s1 = self.rd_key[rk_idx + 1] ^ X(d0, d3, d2, d1)
            s2 = self.rd_key[rk_idx + 2] ^ X(d3, d2, d1, d0)
            s3 = self.rd_key[rk_idx + 3] ^ X(d2, d1, d0, d3)

        rk_idx += 4

        out32[0] = ReverseU32(self.rd_key[rk_idx + 0] ^ O(d3, d2, d1, d0))
        out32[1] = ReverseU32(self.rd_key[rk_idx + 1] ^ O(d2, d1, d0, d3))
        out32[2] = ReverseU32(self.rd_key[rk_idx + 2] ^ O(d1, d0, d3, d2))
        out32[3] = ReverseU32(self.rd_key[rk_idx + 3] ^ O(d0, d3, d2, d1))


class AES_DATA(object):
    # 0x178 byte
    _data: byteClass = None
    # D: List[int] = None  # 92 * 4 byte = 368 byte
    # single block function pointer : 4 byte
    # ctx pointer : 4byte
    ctx: AES_CTX = None

    def __init__(self, ctx: AES_CTX = None):
        super(AES_DATA, self).__init__()
        self._data = byteClass.fromhex("00" * 0x170)
        self.ctx = ctx

    def __ne__(self, other):
        if not isinstance(other, AES_DATA):
            return True

        if self._data != other._data:
            return True

        return False

    def __eq__(self, other):
        return not self.__ne__(other)

    @classmethod
    def from_bytes(cls, data: bytes):  # for pytest
        assert len(data) == 0x170
        obj = cls()
        obj._data = byteClass(data)
        return obj

    @classmethod
    def from_hex(cls, data: str, ctx: AES_CTX = None):  # for pytest
        assert len(data) in [0x178 * 2, 0x170 * 2]
        obj = cls().from_bytes(bytes.fromhex(data[:0x170 * 2]))
        obj.ctx = ctx
        return obj

    @property
    def DA1(self):
        return self._data.with_offset_u8(0)

    @property
    def DA4(self):
        return self._data.with_offset_u32(0)

    @property
    def DA8(self):
        return self._data.with_offset_u64(0)

    @property
    def DB1(self):
        return self._data.with_offset_u8(80)

    @property
    def DB4(self):
        return self._data.with_offset_u32(80)

    @property
    def DB8(self):
        return self._data.with_offset_u64(80)

    def clear(self):
        self._data = byteClass(b"\0" * 0x170)

    def initialize(self, ctx: AES_CTX):
        """
            ver 7.9.0 : .text:02424863 ; int __cdecl sub_2424863(AES_DATA *s, ctx, fn)
        """
        self.clear()
        self.ctx = ctx

        self.ctx.single_block_encrypt(self.DB1, self.DB1)

        m21 = ReverseU32(self.DB4[0])
        m20 = ReverseU32(self.DB4[1])
        m23 = ReverseU32(self.DB4[2])
        m22 = ReverseU32(self.DB4[3])

        v6 = self.DB1[15]

        self.DB4[0] = m20
        self.DB4[1] = m21
        self.DB4[2] = m22
        self.DB4[3] = m23

        m10 = u32(__PAIR_R1__(m21, m20))
        m11 = u32(-(v6 & 0x1)) & 0xE1000000 ^ (m21 >> 1)
        m12 = u32(__PAIR_R1__(m23, m22))
        m13 = u32(__PAIR_R1__(m20, m23))

        n20 = u32(__PAIR_R1__(m11, m10))
        n21 = u32(-(m12 & 0x1)) & 0xE1000000 ^ (m11 >> 1)
        n22 = u32(__PAIR_R1__(m13, m12))
        n23 = u32(__PAIR_R1__(m10, m13))

        n10 = u32(__PAIR_R1__(n21, n20))
        n11 = u32(-(n22 & 0x1)) & 0xE1000000 ^ (n21 >> 1)
        n12 = u32(__PAIR_R1__(n23, n22))
        n13 = u32(__PAIR_R1__(n20, n23))

        M = [
            [0, 0, 0, 0],
            [m10, m11, m12, m13],
            [m20, m21, m22, m23],
            [0, 0, 0, 0],
        ]
        N = [
            [0, 0, 0, 0],
            [n10, n11, n12, n13],
            [n20, n21, n22, n23],
            [0, 0, 0, 0],
        ]

        for i in range(4):
            M[3][i] = M[1][i] ^ M[2][i]
            N[3][i] = N[1][i] ^ N[2][i]

        idx = 4
        for i in range(4):
            for j in range(4):
                for k in range(4):
                    self.DB4[idx] = M[i][k] ^ N[j][k]
                    idx += 1

    def set_iv(self, iv: bytePtr):
        """
            ver 7.9.0 : .text:02424CAE ; _DWORD __cdecl aes_hash_with_random(AES_DATA *a1, _BYTE *randomData, _DWORD le
        """
        iv = iv.as_u8
        v5 = 0
        self.DB8[35] = 0
        self.DA8[0] = 0
        self.DA8[1] = 0
        self.DA8[6] = 0
        self.DA8[7] = 0
        self.DA8[8] = 0
        self.DA8[9] = 0

        if len(iv) == 12:
            memcpy(self.DA1, iv, len(iv))
            self.DA1[15] = 1
            v5 = 2
        else:
            assert NotImplementedError("todo")

        self.ctx.single_block_encrypt(self.DA1, self.DA8.offset(4))
        self.DA4[3] = ReverseU32(v5)

        return v5 >> 16

    def _inc_count(self):
        n = ReverseU32(self.DA4[3])
        self.DA4[3] = ReverseU32(n+1)

    def _encode_body_0xC00(self, in_data: bytePtr, out_data: bytePtr, len_data: int):
        offset = 0
        u32in = in_data.as_u32
        u32out = out_data.as_u32

        if len_data < 0xC00:
            return offset

        while len_data - offset > 0xC00:
            pOut = u32out.clone()

            for i in range(192):
                self.ctx.single_block_encrypt(self.DA1, self.DA1.offset(16))
                self._inc_count()
                for j in range(4):
                    pOut[j] = u32in[j] ^ self.DA4[j+4]
                pOut = pOut.byte_offset(16)
                u32in = u32in.byte_offset(16)
                offset += 16

            InvMix_2(self.DB1.byte_offset(16), self.DA1.byte_offset(64), u32out, 0xC00)
            u32out = pOut.clone()

        return offset

    def _encode_body_0x10(self, in_data: bytePtr, out_data: bytePtr, len_data: int):
        offset = 0
        u32in = in_data.as_u32
        u32out = out_data.as_u32
        pOut = out_data.as_u32

        if len_data < 0x10:
            return offset

        while len_data - offset >= 0x10:
            self.ctx.single_block_encrypt(self.DA1, self.DA1.offset(16))
            self._inc_count()

            for j in range(4):
                pOut[j] = u32in[j] ^ self.DA4[j+4]

            pOut = pOut.byte_offset(16)
            u32in = u32in.byte_offset(16)

            offset += 0x10

        InvMix_2(self.DB1.byte_offset(16), self.DA1.byte_offset(64), u32out, len_data & 0xFFFFFFF0)

        return offset

    def _encode_body_0x1(self, in_data: bytePtr, out_data: bytePtr, len_data: int):

        u8in = in_data.as_u8
        u8out = out_data.as_u8

        offset = 0
        if len_data < 1:
            return offset

        self.ctx.single_block_encrypt(self.DA1, self.DA1.offset(16))
        self._inc_count()

        for i in range(len_data):
            u8out[i] = u8in[i] ^ self.DA1[i + 16]
            self.DA1[i + 64] ^= u8out[i]

        return len_data

    def encode_body(self, in_data: bytePtr, out_data: bytePtr, len_data: int):
        """
            ver 7.9.0 : .text:02425277 ; signed int __cdecl aes_encode_body(AES_DATA *a1, _BYTE *a2, _BYTE *a3, _DWORD a4)
        """
        offset = 0
        v5 = len_data + self.DA8[7]
        if v5 > 0xFFFFFFFE0:
            return -1

        self.DA8[7] = v5

        if self.DB4[71]:
            InvMix_1(self.DA1.byte_offset(64), self.DB1.byte_offset(16))
            self.DB4[71] = 0

        if self.DB4[70]:
            return 0

        offset += self._encode_body_0xC00(
            in_data.byte_offset(offset),
            out_data.byte_offset(offset),
            len_data - offset
        )

        # hexdump(out_data._obj._data)

        offset += self._encode_body_0x10(
            in_data.byte_offset(offset),
            out_data.byte_offset(offset),
            len_data - offset
        )
        # hexdump(out_data._obj._data)

        ret = self._encode_body_0x1(
            in_data.byte_offset(offset),
            out_data.byte_offset(offset),
            len_data - offset
        )
        # hexdump(out_data._obj._data)

        self.DB4[70] = ret

        return ret

    def _decode_body_0xC00(self, in_data: bytePtr, out_data: bytePtr, len_data: int):
        offset = 0

        u32in = in_data.as_u32
        u32out = out_data.as_u32

        if len_data < 0xC00:
            return offset

        while len_data - offset > 0xC00:
            InvMix_2(self.DB1.byte_offset(16), self.DA1.byte_offset(64), u32in, 0xC00)
            pOut = u32out.clone()

            for i in range(192):
                self.ctx.single_block_encrypt(self.DA1, self.DA1.byte_offset(16))
                self._inc_count()
                for j in range(4):
                    pOut[j] = u32in[j] ^ self.DA4[j+4]
                pOut = pOut.byte_offset(16)
                u32in = u32in.byte_offset(16)
                offset += 16

            u32out = pOut.clone()
        return offset

    def _decode_body_0x10(self, in_data: bytePtr, out_data: bytePtr, len_data: int):
        offset = 0
        u32in = in_data.as_u32
        pOut = out_data.as_u32

        if len_data < 0x10:
            return offset

        InvMix_2(self.DB1.byte_offset(16), self.DA1.byte_offset(64), u32in, len_data & 0xFFFFFFF0)

        while len_data - offset >= 0x10:
            self.ctx.single_block_encrypt(self.DA1, self.DA1.offset(16))
            self._inc_count()

            for j in range(4):
                pOut[j] = u32in[j] ^ self.DA4[j + 4]

            pOut = pOut.byte_offset(16)
            u32in = u32in.byte_offset(16)

            offset += 0x10

        return offset

    def _decode_body_0x1(self, in_data: bytePtr, out_data: bytePtr, len_data: int):

        u8in = in_data.as_u8
        u8out = out_data.as_u8

        offset = 0
        if len_data < 1:
            return offset

        self.ctx.single_block_encrypt(self.DA1, self.DA1.offset(16))
        self._inc_count()

        for i in range(len_data):
            self.DA1[i + 64] ^= u8in[i]
            u8out[i] = u8in[i] ^ self.DA1[i + 16]

        return len_data

    def decode_body(self, in_data: bytePtr, out_data: bytePtr, len_data: int):
        """
            ver 7.9.0 : .text:02425603 aes_decode_body
        """
        offset = 0
        v5 = len_data + self.DA8[7]
        if v5 > 0xFFFFFFFE0:
            return -1

        self.DA8[7] = v5

        if self.DB4[71]:
            InvMix_1(self.DA1.byte_offset(64), self.DB1.byte_offset(16))
            self.DB4[71] = 0

        if self.DB4[70]:
            return 0

        offset += self._decode_body_0xC00(
            in_data.byte_offset(offset),
            out_data.byte_offset(offset),
            len_data - offset
        )

        # hexdump(out_data._obj._data)

        offset += self._decode_body_0x10(
            in_data.byte_offset(offset),
            out_data.byte_offset(offset),
            len_data - offset
        )
        # hexdump(out_data._obj._data)

        ret = self._decode_body_0x1(
            in_data.byte_offset(offset),
            out_data.byte_offset(offset),
            len_data - offset
        )
        # hexdump(out_data._obj._data)

        self.DB4[70] = ret

        return ret

    def xmm(self, out_data:bytearray):
        aes_xmm(self.DA1.as_u8)

        val = self.DA8.offset(8).as_u128[0]
        out_data[:] = val.to_bytes(16, byteorder='little')


def _convert_to_bytePtr(d):
    if isinstance(d, str):
        return byteClass(d.encode('utf-8')).u8
    elif isinstance(d, (bytes, bytearray)):
        return byteClass(d).u8
    elif isinstance(d, (byteClass)):
        return d.u8
    return d


AesType = Union[str, bytes, bytearray, byteClass, bytePtr]


def ts_aes_encode(key: AesType, iv: AesType, in_body: AesType, out_buff: bytearray, out_dest: bytearray):
    aes_ctx = AES_CTX()
    aes_data = AES_DATA()

    key = _convert_to_bytePtr(key).as_u8
    iv = _convert_to_bytePtr(iv).as_u8
    in_body = _convert_to_bytePtr(in_body).as_u8

    aes_ctx.set_encrypt_key(userKey=key, bits=len(key) * 8)

    aes_data.initialize(aes_ctx)

    aes_data.set_iv(iv=iv)

    len_body = len(in_body)
    buff = byteClass(bytearray([0] * len_body)).u8

    aes_data.encode_body(in_data=in_body, out_data=buff, len_data=len_body)

    aes_data.xmm(out_dest)

    out_buff[:] = buff.data()

    return True


def ts_aes_decode(key: AesType, iv: AesType, in_body: AesType, out_buff: bytearray, out_dest: bytearray):
    aes_ctx = AES_CTX()
    aes_data = AES_DATA()

    key = _convert_to_bytePtr(key).as_u8
    iv = _convert_to_bytePtr(iv).as_u8
    in_body = _convert_to_bytePtr(in_body).as_u8

    aes_ctx.set_encrypt_key(userKey=key, bits=len(key) * 8)

    aes_data.initialize(aes_ctx)

    aes_data.set_iv(iv=iv)

    len_body = len(in_body)
    buff = byteClass(bytearray([0] * len_body)).u8

    aes_data.decode_body(in_data=in_body, out_data=buff, len_data=len_body)

    aes_data.xmm(out_dest)

    out_buff[:] = buff.data()
    return True


# -----------------------------------------------------------
# Fast response decryption
# -----------------------------------------------------------
# `ts_aes_decode` above is a line-by-line port of the game's AES and runs at
# roughly 22 us per byte: 3.5 s for a 150 KB city, 17 s for a 750 KB one. On a
# small instance that becomes minutes, which is exactly why a large city used to
# fail while a small one downloaded fine - the AES, not any size limit, was the
# effective ceiling on city size.
#
# Decrypting a response needs only the CTR keystream. `set_iv` builds
# J0 = iv || 0x00000001, and the data blocks start at inc32(J0): counter blocks
# iv || 00000002, 00000003, ... with the counter in bytes 12..15. That is
# precisely what `modes.CTR` does with `iv + b"\x00\x00\x00\x02"`. Measured
# byte-for-byte identical to the port on two real FetchCity bodies (153,534 B
# and 761,217 B) and on round trips at 16 / 1,000 / 70,000 / 300,000 B.
#
# This path is deliberately NOT used to build a request: the ts-id auth tag is a
# Playrix GHASH variant only the port above can produce (see the note at the top
# of this file), so `ts_aes_encode` is untouched.
#
# `cryptography` is optional. Without it - or should anything here ever disagree
# - we fall back to the port, so a missing package costs time and never
# correctness.

_AES_CTR_CIPHER = None  # None = not probed yet, False = unavailable


def _aes_ctr_decrypt(body, iv) -> "bytearray | None":
    """AES-CTR decrypt via `cryptography`, or None when the fast path is unusable."""
    global _AES_CTR_CIPHER
    if len(iv) != 12:
        return None
    if _AES_CTR_CIPHER is None:
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

            def cipher(data: bytes, iv_bytes: bytes) -> bytes:
                dec = Cipher(
                    algorithms.AES(TS_AES_KEY),
                    modes.CTR(iv_bytes + b"\x00\x00\x00\x02"),
                ).decryptor()
                return dec.update(data) + dec.finalize()

            _AES_CTR_CIPHER = cipher
        except Exception:
            _AES_CTR_CIPHER = False
    if _AES_CTR_CIPHER is False:
        return None
    try:
        return bytearray(_AES_CTR_CIPHER(bytes(body), bytes(iv)))
    except Exception:
        return None


def ts_aes_decode_with_tsid(body: Union[bytearray, bytes], ts_id: str) ->bytearray:
    assert len(ts_id) == 3 + 24 + 32
    assert ts_id[:3] == "002"

    iv_bytes = bytearray.fromhex(ts_id[3:3 + 24])

    fast = _aes_ctr_decrypt(body, iv_bytes)
    if fast is not None:
        return fast

    key = byteClass(TS_AES_KEY)
    inbody = byteClass(body)
    iv = byteClass(iv_bytes)

    # call
    buff = bytearray([])
    dest = bytearray([])

    ts_aes_decode(key=key.u8, iv=iv.u8, in_body=inbody.u8, out_buff=buff, out_dest=dest)

    return buff

# ============================================================
# ts_gzip
# ============================================================

import zlib


ZLIB_COMPRESS_LEVEL = 8
ZLIB_MEMORY_LEVEL = 8
ZLIB_WBITS = 31


def ts_compress(data) -> bytearray:
    if isinstance(data, str):
        data = data.encode('utf-8')

    deflate = zlib.compressobj(
        level=ZLIB_COMPRESS_LEVEL,
        method=zlib.DEFLATED,
        wbits=ZLIB_WBITS,
        memLevel=ZLIB_MEMORY_LEVEL,
        strategy=zlib.Z_DEFAULT_STRATEGY,
    )
    ret = bytearray(deflate.compress(data) + deflate.flush())
    # fake
    return ret


def ts_uncompress(data) -> bytearray:
    inflate = zlib.decompressobj(ZLIB_WBITS)
    ret = bytearray(inflate.decompress(data) + inflate.flush())
    return ret


def ts_decompress(data) -> bytearray:
    return ts_uncompress(data)



# ============================================================
# ts_file (0x54 / 0x79 / etc. decoders for the FetchCity payload)
# ============================================================
import base64
from pathlib import Path
import random
from typing import Union

try:
    import zstd
except ImportError:
    zstd = None
import zlib


def mmh2(data: Union[bytes, bytearray], length: int, seed: int):
    m = 0x5bd1e995
    r = 24
    h = seed ^ length

    i = 0
    while length >= 4:
        k = int.from_bytes(data[i:i+4], byteorder='little', signed=False)

        k = u32(k * m)
        k = u32(k) ^ u32(k >> r)
        k = u32(k * m)

        h = u32(h * m)
        h = u32(h ^ k)

        i += 4
        length -= 4

    if length >= 3:
        h ^= data[i + 2] << 16
    if length >= 2:
        h ^= data[i + 1] << 8
    if length >= 1:
        h ^= data[i + 0]
        h = u32(h * m)

    h ^= h >> 13
    h = u32(h * m)
    h ^= h >> 15

    return u32(h)


def get_hash_table(length: int, seed: int) -> bytearray:
    length = u32(length)
    seed = u32(seed)
    table = bytearray([0] * 0x2d7)

    h = seed
    for i in range(0, 0x2d7, 4):
        v = h.to_bytes(4, 'little')
        h = mmh2(v, 4, length)

        v = h.to_bytes(4, 'little')
        for j in range(0, 4):
            if i + j >= 0x2d7:
                break
            table[i + j] = v[j]

    return table


def get_hash_table2(key: int) -> bytes:
    """
       ver 7.9.0 : .text:00361576 get_hash_table_2 proc near

    Parameters
    ----------
    key

    Returns
    -------

    """
    ret = ''
    if key == 0x41 :
        ret += "AO[hUyI.o|q@p^ Ms1I7 Zub:a'O4Y'_0;XmZ~vK=nJ#wYCccn^CzJu4<f5ogy]}#K5FIlKnnwT_^dVAZgv]D WIt@sl!i=)qxnWh'QuBgR~yZe"
        ret += "oh-cC@q@>6-VvT2,ZSWlU~th+%0|W_iPl}M0un?pydqul`|ZL`u7rm1L0ewz4c9*fnRZF:8(;&%6[Gn>,LXW9F?QQ41(:5svrGV#{'3)]2/6ln["
        ret += "sYds:qTdBh8OyB<#Q!U%Q'[d+r%)OBOuy]!=}ag0GP6Z~`+9>rF&`_8^}N~X02D)H#}aO)08tqx:,O&fNp{R$W>)MBeLi|RX:.z'5B%g]13Ef y"
        ret += "%K?{RApgk{.1),Z]_l,]v~'mrvB)uG.sw2P%Q+|NQL`>IfyLwd],I?f+ig:o8s#LRMy($0Y2VzXBEV~oph4p/dumT(6x{3Q~&mma)%/~BRcnojy"
        ret += "TfT.yqn&sk9j;ay3pg+,ccJG=TEu2K-*d%IU*Y2N).}{UP_N*x?u9fw$Vgj%AtBG+dRE(:n(tI'b47?szaINkm8{<7jL#t;SJ;I'_vrVCoz!E2y"
        ret += "*<n&RjOeoiOE3[?ILO+?dS@u|]vVIHgivtw#_rlogL?rclJkA2V6dH_av 7aSZ6RBgQbL)fW11b<'GW'M)N#ll^qZ{]:baj@nv9YQy`(8'&w_v("
        ret += "PST6KH0OJB04xx>RC3!kRx*|+25^OSh.X'&N>`m9KfIWo|S2jhbc fTd"
    else:
        ret += "BLD18qQhOwEylkVki91hjILTcIwbEMhUHamjkAzgyIWnl1tqOZvO+7AvOTqn036uyHAQVVbSH3/BzYMjNHTMXvogJBWI1siiMZF2zFzD0GEpuGd"
        ret += "F+WbSIrug4fzHojQ/AAaBx2HT/tZ8hP+ITRc8z9a7ecsrGX+EBq+b3mada6zeJPxE2j47psb/J4Xnx0AEfh+lEb2GLpczI7e3o0BGP9GlmQYPSX"
        ret += "INq87N2D8G175+cBwbMmzdfsIxr9hNGJgLGTFe/NdMP6NoAERNJOij9vzbgwiaOpdvmqBkV2HLp//Pj28HgIc392BrzFQ/slGN0/TqxugL1UY9G"
        ret += "MpmI+GQVDSMzswGVWZ5VMjs4sSvkAmQ/p5AnrRyDoszxO+SKI5HV+OwHS0G7NcKXUMCx32xk6mVNxcpl0DwivGhJuvk/gphiG0b2f0gciQaaDJz"
        ret += "uOJASND397ryTg4EuRYRw8D2A1lNF5lGEkzxMCGi56t4zCLduBcROWbbjBKKZer6enhbgsEytVBmzo4ONfQ+ZFv3sLhaEb72lnMkVKDD3tw7hzA"
        ret += "oL86ObHGLOEGMUY3n9wihn1peBNBTcL3kSfH4/t9KF4qZ3GtXA++WO1h5/0edqVhDygXMUzQ87EZvcGuqLMk6iR08pFBO529aAADg8o9hHKfspY"
        ret += "vwghDW/5HtJGL7CrGpE4Sr8FnvNvv7J3AGa9csWrhMB00P/dupnCafDuJAeCgFL0l"

    return ret.encode('ascii')


def _encode_0x79(in_bytearray: bytearray):
    string_length = len(in_bytearray)
    size = string_length

    hash_length = u32((size ^ 0x396A8) + ((string_length+8) ^ 0xC5EED) )
    hash_seed = random.randint(0, 0xFFFFFFFF)

    out_buffer = bytearray([0x79])
    out_buffer[0] = 0x79
    out_buffer += hash_length.to_bytes(length=3, byteorder='little', signed=False)
    out_buffer += hash_seed.to_bytes(length=4, byteorder='little', signed=False)
    out_buffer += in_bytearray

    hashtable = get_hash_table(length=hash_length, seed=hash_seed + 4)

    i = 8
    j = 0

    prev = 0

    for idx in range(string_length):
        curr = out_buffer[i]
        out_buffer[i] ^= hashtable[j]
        out_buffer[i] = u8(prev + out_buffer[i])
        prev = curr
        i += 1
        j = (j+1) % 0x2d7

    return out_buffer


def _decode_0x79(in_bytearray: bytearray, string_length: int):
    """
        .text:01109ACA xml_decode_0x79 proc near

    Parameters
    ----------
    in_bytearray

    out_bytearray

    Returns
    -------

    """
    t = in_bytearray[0]
    assert t == 0x79

    hash_length = int.from_bytes(in_bytearray[1:1+3], byteorder='little', signed=False)
    hash_seed = int.from_bytes(in_bytearray[4:4+4], byteorder='little', signed=False)

    hashtable = get_hash_table(length=hash_length, seed=hash_seed + 4)

    size = u32((hash_length - (string_length ^ 0xC5EED))) ^ 0x396A8

    out_bytearray = in_bytearray[8:]

    i, j = 0, 0
    while i < size:
        if i > 0:
            out_bytearray[i] = u8(out_bytearray[i] - out_bytearray[i-1])
        out_bytearray[i] ^= hashtable[j]

        i += 1
        j = (j + 1) % 0x2d7

    return out_bytearray


def _decode_0x7D(in_bytearray: bytearray):
    key = in_bytearray[0]
    assert key == 0x7D

    hashtable = get_hash_table2(key ^ 0x3C)

    out_bytearray = in_bytearray[:]

    size = len(out_bytearray)
    len_hashtable = len(hashtable)

    i, j = 0, 0
    while i < size:
        out_bytearray[i] ^= hashtable[j]

        i += 1
        j = (j + 1) % len_hashtable
    return out_bytearray


# def _decode_0x50(in_bytearray: bytearray):
#     key = in_bytearray[0]
#     assert key == 0x50
#
#     hashtable = get_hash_table2(key ^ 0x3C)
#
#     out_bytearray = in_bytearray[:]
#
#     size = len(out_bytearray)
#     len_hashtable = len(hashtable)
#
#     i, j = 0, 0
#     while i < size:
#         if i > 0:
#             out_bytearray[i] = u8(out_bytearray[i] - out_bytearray[i - 1])
#         out_bytearray[i] ^= hashtable[j]
#
#         i += 1
#         j = (j + 1) % len_hashtable
#
#     return out_bytearray


def _decode_0x66(in_bytearray: bytearray):
    key = in_bytearray[0]
    assert key == 0x66

    hashtable = get_hash_table2(66)

    out_bytearray = in_bytearray[:]

    size = len(out_bytearray)
    len_hashtable = len(hashtable)

    i, j = 0, 0
    while i < size:
        if i > 0:
            out_bytearray[i] = u8(out_bytearray[i] - out_bytearray[i - 1])

        out_bytearray[i] ^= hashtable[j]

        i += 1
        j = (j + 1) % len_hashtable
    return out_bytearray


def _decode_0xAD(in_bytearray: bytearray):
    key = in_bytearray[0]
    assert key == 0x6f

    hashtable = get_hash_table2(88)

    out_bytearray = in_bytearray[:]

    size = len(out_bytearray)
    len_hashtable = len(hashtable)

    i, j = 0, 0
    while i < size:
        if i > 0:
            out_bytearray[i] = u8(out_bytearray[i] - out_bytearray[i - 1])

        out_bytearray[i] ^= hashtable[j]

        i += 1
        j = (j + 1) % len_hashtable
    return out_bytearray


def _deocode_xor(in_bytearray: bytearray) -> bytearray:
    """
    .text:01F0474E ; unsigned int __cdecl xml_xor(xmldata *a1, int bDecode, unsigned int offset, char *pEncodedXml, int length)

    Parameters
    ----------
    in_bytearray

    Returns
    -------

    """
    key_hex = "ca656f74c492d5544b861925a915de6786b7b169af25e22774d39c32d0413c8d39f5b8a77bed3c96a308fb8d7b197b2dbf7e002d845d387215b0ef9fe85abfd8"
    key = bytes.fromhex(key_hex)
    len_key = len(key)

    len_in = len(in_bytearray)

    H32 = 0
    R8 = 0
    out = bytearray([0] * len_in)
    for i in range(len_in):
        k = key[i % len_key]
        c = in_bytearray[i]

        new_val = R8 ^ k ^ c ^ u8(H32) ^ RB2(H32) ^ (u16(H32 ^ (H32 >> 16)) >> 8)
        new_val = u8(new_val)
        out[i] = new_val
        R8 = new_val ^ ROL8(R8, 1)
        H32 = u32(H32 + 0x17)

    return out


def _decode_zstd(in_bytearray: bytearray) -> bytearray:
    dctx = zstd.ZstdDecompressor()
    ret = dctx.decompress(in_bytearray)
    return ret

def _decode_45584c50_case7(in_bytearray: bytearray) -> bytearray:
    pass

def _decode_45584c50(in_bytearray: bytearray) -> bytearray:
    """

        ver 7.9.0 : .text:01F00BC4 ; _BOOL4 __cdecl xml_decode_45584c50(_DWORD *a1, XmlFile *a2, int a3, XmlStatus *a4)
        ver 7.9.5 : .text:01F9F564

    Parameters
    ----------
    in_bytearray

    Returns
    -------

    """

    offset = 0
    read_len = 4
    len_data = len(in_bytearray)

    # todo
    # base64 decode
    # base
    while offset < len_data:
        data = int.from_bytes(in_bytearray[offset:offset+read_len], byteorder='little', signed=False)

        if data == 0x1A4B4C42 or data == 0x45584C50:
            offset += 4
            read_len = 4
            continue
        elif u16(data) == 1:
            offset += 4
            j = u16(data >> 16)
            offset += j  # fixme : check.
            return _deocode_xor(in_bytearray=in_bytearray[offset:])

        elif u16(data) == 2:
            raise NotImplementedError('Not Implemented for case 2')
        elif u16(data) == 3:
            offset += 4
            j = u16(data >> 16)
            offset += j
            key = "QTZmZTNGODQ1ODRkNTRsN0EyNjRBZjM5MTU3c0Y4NnU="
            decoded_key = base64.standard_b64decode(key)
            raise NotImplementedError('Not Implemented for case 3')

        elif u16(data) == 4:
            offset += 4
            j = u16(data >> 16)
            offset += j
            return _decode_zstd(in_bytearray=in_bytearray[offset:])
        elif u16(data) == 5:
            raise NotImplementedError('Not Implemented for case 5')
        elif u16(data) == 6:
            raise NotImplementedError('Not Implemented for case 6')
        elif u16(data) == 7:
            # 0700 0e00 02f1 ca06 0000 79a1 e80f a802 e757 d6b9 81c3 039d 0899 dbbd fe3e 5e05 e6cd b669 34e8 8bfc 28e9 ff05

            offset += 4
            # 02f1 ca06 0000 79a1 e80f a802 e757 d6b9 81c3 039d 0899 dbbd fe3e 5e05 e6cd b669 34e8 8bfc 28e9 ff05
            # j = u16(data >> 16)
            # offset += j
            length_offset = offset + 6 + 1
            length = int.from_bytes(in_bytearray[length_offset: length_offset+3], byteorder='little')

            seed_offset = length_offset + 3
            seed = int.from_bytes(in_bytearray[seed_offset:seed_offset+4], byteorder='little')
            hash_table = get_hash_table(length, seed+4)
            buff = in_bytearray[seed_offset+4:]

            j = 0
            for i in range(len(buff)):
                if i > 0:
                    buff[i] = u8(buff[i] - buff[i-1])
                buff[i] ^= hash_table[j]
                j = (j + 1) % 0x2d7


            # 02f1 ca06 0000 79a1 e80f a802 e757 d6b9 81c3 039d 0899 dbbd fe3e 5e05 e6cd b669 34e8 8bfc 28e9 ff05
            return zlib.decompress(buff, wbits=-zlib.MAX_WBITS|16)
        else:
            raise Exception('Unknown data')

    return in_bytearray

key_0x54 = bytes.fromhex("775F7628505354364B48304F4A42303478783E524333216B52782A7C2B32355E4F53682E5827264E3E606D394B6649576F7C53326A686263206654643761535A3652426751624C2966573131623C274757274D294E236C6C5E715A7B5D3A62616A406E763959517960283827264532792A3C6E26526A4F656F694F45335B3F494C4F2B3F645340757C5D765649486769767477235F726C6F674C3F72636C4A6B4132563664485F617620753966772456676A25417442472B645245283A6E287449276234373F737A61494E6B6D387B3C376A4C23743B534A3B49275F767256436F7A216F706834702F64756D542836787B33517E266D6D6129252F7E4252636E6F6A795466542E79716E26736B396A3B61793370672B2C63634A473D544575324B2D2A642549552A59324E292E7D7B55505F4E2A783F5A5D5F6C2C5D767E276D7276422975472E7377325025512B7C4E514C603E4966794C77645D2C493F662B69673A6F3873234C524D792824305932567A584245567E51754267527E795A656F682D63434071403E362D567654322C5A53576C557E74682B25307C575F69506C7D4D30756E3F70796471756C607C5A4C607537726D314C3065777A3463392A666E525A463A38283B2625365B476E3E2C4C585739463F51513431283A357376724756237B2733295D322F366C6E5B735964733A7154644268384F79423C235121552551275B642B7225294F424F75795D213D7D6167304750365A7E602B393E724626605F385E7D4E7E583032442948237D614F2930387471783A2C4F26664E707B5224573E294D42654C697C52583A2E7A27354225675D313345662079254B3F7B524170676B7B2E31292C414F5B685579492E6F7C7140705E204D73314937205A75623A61274F3459275F303B586D5A7E764B3D6E4A2377594363636E5E437A4A75343C66356F67795D7D234B3546496C4B6E6E77545F5E6456415A67765D442057497440736C21693D2971786E5768")


def _encode_x54(in_bytearray: bytearray, encode_bytes = 279) -> bytearray:
    len_key = len(key_0x54)

    len_indata = min( encode_bytes, len(in_bytearray) + 3)

    pData = in_bytearray[:]

    for i in range(len_indata):
        pData[i] ^= key_0x54[i % len_key]
        if i > 0:
            pData[i] = u8(pData[i] + in_bytearray[i - 1])

    pData[0] = u8(pData[0] + 0x54)
    pData[0:0] = bytearray([
        0x54,
        u8((len_indata)) ^ key_0x54[0],
        u8((len_indata) >> 8)
    ])


    return pData


def _decode_x54(in_bytearray: bytearray, len_indata: int) -> bytearray:
    """
        .text:110A33A fetch_city_response_data_decode

    Parameters
    ----------
    in_bytearray

    Returns
    -------

    """
    len_key = len(key_0x54)

    v10 = (in_bytearray[1] ^ key_0x54[0]) | (in_bytearray[2] << 8)
    len_indata = min(v10, len_indata - 3)

    if len_indata == 3:
        pData = in_bytearray[3:3+3]
    else:
        pData = in_bytearray[3:]

    pData[0] = u8(pData[0] - 0x54)

    for i in range(len_indata):
        if i > 0:
            pData[i] = u8(pData[i] - pData[i - 1])
        pData[i] ^= key_0x54[i % len_key]


    return pData


def _decode_x53(in_bytearray: bytearray, len_indata: int) -> bytearray:
    """
        .text:110A33A fetch_city_response_data_decode

    Parameters
    ----------
    in_bytearray

    Returns
    -------

    """
    assert in_bytearray[0] == 0x53

    key = get_hash_table2(66)
    len_key = len(key)

    v10 = (in_bytearray[1] ^ 0x53) | (in_bytearray[2] << 8)

    len_indata = min(v10, len_indata - 3)

    if len_indata == 3:
        pData = in_bytearray[3:3+3]
    else:
        pData = in_bytearray[3:]

    pData[0] = u8(pData[0] - 0x54)

    for i in range(len_indata):
        if i > 0:
            pData[i] = u8(pData[i] - pData[i - 1])
        pData[i] ^= key[i % len_key]

    return pData


def ts_decode_bytearray(in_bytearray: bytearray, string_length: int) -> bytearray:
    """
    ver 7.9.0 : .text:01109CF7 sub_1109CF7

    Parameters
    ----------
    in_bytearray
        encoded content

    string_length
        length of content

    Returns
        decoded content
    -------

    """
    x = in_bytearray[0] ^ 0x3C

    if in_bytearray[0] == 0x54 and x == 0x68:
        return _decode_x54(in_bytearray=in_bytearray, len_indata=string_length)

    elif in_bytearray[0] == 0x53 and x == 0x6F:
        return _decode_x53(in_bytearray=in_bytearray, len_indata=string_length)

    elif in_bytearray[0] == 0x78 and x == 0x44:
        # .text:01109769 sub_1109769
        raise NotImplementedError()
    elif in_bytearray[0] == 0x79 and x == 0x45:
        return _decode_0x79(in_bytearray=in_bytearray, string_length=string_length)

    elif in_bytearray[0] == 0x64 and x == 0x58:
        raise NotImplementedError('Need to check')

    elif in_bytearray[0] == 0x7D and x == 0x41:
        return _decode_0x7D(in_bytearray=in_bytearray)

    elif in_bytearray[0] == 0x66 and x == 0x5A:
        raise NotImplementedError('Need to check')
        # return _decode_0x66(in_bytearray=in_bytearray)

    elif in_bytearray[0] == 0x6F and x == 0x53:
        raise NotImplementedError('Need to check')
        # return _decode_0xAD(in_bytearray=in_bytearray)

    elif in_bytearray[0] == 0x1F and in_bytearray[1] == 0x8B:  # gzip
        return bytearray(ts_uncompress(in_bytearray))

    elif in_bytearray[0] == 0x3C and x == 0x00:  # '<'
        return in_bytearray[:]

    elif in_bytearray[0] == 0x7b and in_bytearray[-1] == 0x7d: # '{' ~ '}'
        return in_bytearray

    elif in_bytearray[0] == 0x50 and in_bytearray[1] == 0x4c and in_bytearray[2] == 0x58 and in_bytearray[3] == 0x45:
        return _decode_45584c50(in_bytearray=in_bytearray)
    else:
        raise Exception('unknown data')


def ts_decode_file(in_filename: Path, out_filename: Path):
    in_buffer = bytearray(in_filename.read_bytes())
    len_buffer = len(in_buffer)

    out_buffer = ts_decode_bytearray(in_bytearray=in_buffer, string_length=len_buffer)

    while out_buffer[-1] == 0x00:
        del out_buffer[-1]
    out_filename.write_bytes(out_buffer)



# ============================================================
# High-level helpers
# ============================================================
def _build_request_body(json_dict: dict) -> Tuple[bytes, str]:
    """Returns (encrypted_body, ts_id) for a Township API request."""
    json_str = json.dumps(json_dict, separators=(",", ":"))
    compressed = ts_compress(json_str)

    iv = bytearray([random.randint(0, 255) for _ in range(12)])
    out_buff = bytearray([])
    out_dest = bytearray([0] * 16)

    ts_aes_encode(
        key=TS_AES_KEY,
        iv=iv,
        in_body=compressed,
        out_buff=out_buff,
        out_dest=out_dest,
    )

    ts_id = "002" + iv.hex() + out_dest.hex()
    return bytes(out_buff), ts_id


def _decrypt_response(body: bytes, ts_id: str) -> bytes:
    """AES-decrypt + gunzip the response body."""
    decoded = ts_aes_decode_with_tsid(body=bytearray(body), ts_id=ts_id)
    return bytes(ts_uncompress(decoded))


def fetch_city(
    own_city_id: str,
    target_city_id: str,
    bver: str = "39.0.3",
    fver: str = "3903",
    city_ver: int = 0,
    timeout: float = 300.0,
) -> Tuple[bytes, dict]:
    """
    Perform a FetchCity HTTP request for `target_city_id`.

    Returns (xml_bytes, json_meta) where xml_bytes is the friend's full game XML
    (already gunzipped + 0x54-decoded) and json_meta is the JSON envelope without `data`.
    """
    # ---- per-reference: cityId in body AND query string is "" ----
    json_body = {
        "cityId": "",
        "cityVer": city_ver,
        "fetchCityId": target_city_id,
        "important": True,
    }

    body_bytes, ts_id = _build_request_body(json_body)

    headers = {
        "ts-bp": "i",
        "ts-bver": bver,
        "ts-fver": fver,
        "ts-gpid": "new",
        "ts-id": ts_id,
        "Content-Type": "application/octet-stream",
        # Match the legacy Python requests transport more closely.
        "User-Agent": "python-requests/2.31.0",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
    }

    url = API_URL.format(endpoint="FetchCity") + "?cityId="
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content = resp.read()
            resp_headers = resp.headers
    except urllib.error.HTTPError as e:
        # Do not leak the upstream body to the Studio UI. Keep the status precise.
        if e.code == 403:
            raise RuntimeError("FetchCity HTTP 403: Forbidden") from e
        raise RuntimeError(f"FetchCity HTTP {e.code}: request rejected") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"FetchCity network error: {e.reason}") from e

    resp_ts_id = resp_headers.get("ts-id") or resp_headers.get("Ts-Id") or ""
    if not resp_ts_id:
        for k, v in resp_headers.items():
            if k.lower() == "ts-id":
                resp_ts_id = v
                break
    if not resp_ts_id:
        raise RuntimeError("Server response missing ts-id header")

    json_bytes = _decrypt_response(content, resp_ts_id)
    json_obj = json.loads(json_bytes, strict=False)

    result = json_obj.get("result", {})
    b64_data = result.get("data", None)
    if not b64_data:
        # Server returned an error envelope
        raise RuntimeError(f"FetchCity returned no data; envelope: {json_obj}")

    raw = bytearray(base64.b64decode(b64_data))
    decoded = ts_decode_bytearray(raw, len(raw))
    xml_bytes = bytes(ts_uncompress(decoded))

    # Strip the heavy data field for caller convenience
    meta = dict(json_obj)
    if "result" in meta and isinstance(meta["result"], dict):
        meta["result"] = {k: v for k, v in meta["result"].items() if k != "data"}

    return xml_bytes, meta


# ============================================================
# Convenience: parse own cityId/token + game version from a LocalInfo.xml
# ============================================================
import re as _re

def parse_local_info(local_info_xml: Union[str, bytes]) -> dict:
    """
    Extract cityId, token, bver, fver from a *decoded* LocalInfo.xml.
    Pass the result of ts_decode_bytearray() on the raw file bytes.
    """
    if isinstance(local_info_xml, (bytes, bytearray)):
        s = local_info_xml.decode("utf-8", errors="replace")
    else:
        s = local_info_xml

    out = {"city_id": "", "token": "", "bver": "39.0.3", "fver": "3903"}

    aws = _re.search(r"<AWS\b([^>]*)>", s)
    if aws:
        a = aws.group(1)
        m = _re.search(r'cityId="([^"]*)"', a);  out["city_id"] = m.group(1) if m else ""
        m = _re.search(r'token="([^"]*)"', a);   out["token"]   = m.group(1) if m else ""

    ver = _re.search(r"<Version\b([^>]*)/?>", s)
    if ver:
        a = ver.group(1)
        m = _re.search(r'version="([^"]*)"', a); out["bver"] = m.group(1) if m else out["bver"]
        m = _re.search(r'FVer="([^"]*)"', a);    out["fver"] = m.group(1) if m else out["fver"]

    return out


# ============================================================
# High-level framed API call + LocalInfo decode (cards live-send)
# ============================================================

def _error_text(raw: bytes) -> str:
    """Pull the human part out of the game's plain-JSON error body."""
    try:
        j = json.loads(raw.decode("utf-8", "replace"), strict=False)
    except Exception:
        return ""
    err = j.get("error") if isinstance(j, dict) else None
    if isinstance(err, dict):
        return str(err.get("code") or err.get("message") or "")
    if isinstance(err, str):
        return err
    return ""


def api_request(
    endpoint: str,
    body: dict,
    *,
    host: str = "",
    bver: str = "",
    fver: str = "",
    token: str = "",
    query: str = "",
    timeout: float = 30.0,
) -> dict:
    """POST one framed request to the Playrix TS API and decrypt the reply.

    Returns a JSON-safe dict: ``{ok, status, resp?, error?, body?}``. This is
    the Python-side contract the desktop client's cards methods speak, and it
    mirrors `api_call.py` in the reference tool one-for-one — the frame codec
    lives here so a request and its response can never drift apart.
    """
    if not endpoint or not bver or not fver:
        return {"ok": False, "status": 0, "error": "endpoint/bver/fver required"}
    try:
        body_bytes, ts_id = _build_request_body(body if isinstance(body, dict) else {})
        headers = {
            "ts-bp": "i",
            "ts-bver": bver,
            "ts-fver": fver,
            "ts-gpid": "new",
            "ts-id": ts_id,
            "Content-Type": "application/octet-stream",
            "User-Agent": "python-requests/2.31.0",
            "Accept": "*/*",
            "Connection": "keep-alive",
        }
        if token:
            headers["ts-token"] = token

        url = api_url(endpoint, host) + (query or "")
        rq = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(rq, timeout=timeout) as resp:
                status, raw, hdrs = resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            status, raw, hdrs = e.code, e.read(), e.headers

        if status == 200:
            ts = hdrs.get("ts-id") or ""
            if not ts:
                for k, v in hdrs.items():
                    if str(k).lower() == "ts-id":
                        ts = v
                        break
            if ts:
                plain = _decrypt_response(raw, ts)
                return {"ok": True, "status": status, "resp": json.loads(plain, strict=False)}
            # Unframed plain JSON (some error shapes) — hand it through.
            return {
                "ok": True,
                "status": status,
                "resp": json.loads(raw.decode("utf-8", "replace"), strict=False),
            }

        msg = _error_text(raw)
        return {
            "ok": False,
            "status": status,
            "error": msg or f"HTTP {status}",
            "body": raw.decode("utf-8", "replace")[:300],
        }
    except Exception as e:
        return {"ok": False, "status": 0, "error": str(e)[:300]}


_SHELL_ERROR_MARKERS = (
    "permission denied",
    "not found",
    "no such file",
    "unable to open",
    "not a directory",
    "read-only file system",
)


def decode_local_info(raw) -> str:
    """Decode a pulled LocalInfo/mGameInfo file (bytes) to UTF-8 XML.

    Device builds wrap the document in one of several byte containers, so this
    dispatches on the leading byte via `ts_decode_bytearray` (0x54 / 0x79 / 0x7D
    / gzip / plain '<'). A shell error text the ADB fallback returned instead of
    the file is detected first and reported as a device problem (root not
    enabled), not an unknown format.
    """
    if isinstance(raw, str):
        raw = raw.encode("utf-8", "replace")
    if not raw:
        raise ValueError("LocalInfo is empty")

    head = raw[:64].decode("utf-8", "replace").lstrip("\ufeff").strip().lower()
    for marker in _SHELL_ERROR_MARKERS:
        if marker in head and not head.startswith("<"):
            raise ValueError(
                f'could not read LocalInfo from the device (ADB said: "{head[:120]}") — '
                "check the emulator is rooted and open Homescapes at least once"
            )

    try:
        decoded = ts_decode_bytearray(bytearray(raw), len(raw))
        s = bytes(decoded).decode("utf-8", "replace").lstrip("\ufeff").strip()
        if "<" in s[:64]:
            return s
    except Exception:
        pass

    txt = raw.decode("utf-8", "replace").lstrip("\ufeff").strip()
    if txt.startswith("<"):
        return txt
    raise ValueError(
        f"LocalInfo unrecognized format (first byte 0x{raw[0]:02x}); cannot read Version/FVer"
    )
