# 제3자 고지 (Third-Party Notices)

## 1. 배포물에 포함된 외부 코드
**없음.** `extension/` 폴더(= 설치되는 확장프로그램)에는 npm 패키지, 외부 라이브러리, 외부 글꼴·이미지가 전혀 들어 있지 않습니다. 모든 코드는 이 프로젝트에서 직접 작성했습니다.

## 2. 구현할 때 참고한 규격과 공개 구현 (코드를 그대로 가져오지는 않음)
| 자료 | 어디에 참고했나 | 라이선스·지위 |
|---|---|---|
| RFC 6238 (TOTP), RFC 4226 (HOTP) | `core/totp.js`, 시험 벡터 | IETF 문서 |
| RFC 4648 (Base32) | `core/base32.js`, `core/migration.js` | IETF 문서 |
| RFC 9106 (Argon2), RFC 7693 (BLAKE2) | `core/argon2.js`, 시험 벡터 | IETF 문서 |
| Argon2 참조 구현 (P-H-C/phc-winner-argon2) | `core/argon2.js`의 알고리즘 구조 확인 | CC0-1.0 또는 Apache-2.0 이중 라이선스 (저장소 안의 BLAKE2 코드는 CC0) |
| Project Nayuki — QR Code generator library | `core/qr.js`의 오류정정 블록 표·정렬 패턴 위치·마스크·코드워드 배치 방식, `tests/make_qr.py`(시험용 QR 생성기)의 구조 | MIT (아래 전문 참고) |
| Google Authenticator Key URI Format | `core/uri.js` | 공개 문서 |
| Google Authenticator "계정 내보내기" 데이터 형식 | `core/migration.js` | 공식 문서가 없는 형식. 공개된 protobuf 필드 구조를 바탕으로 직접 구현 |
| OWASP Password Storage Cheat Sheet | Argon2id(19 MiB·2회·병렬 1)·PBKDF2(60만 회) 권고 수치 | 권고 수치만 참조 |
| QR Code (ISO/IEC 18004) | QR 구조 | 규격서 자체는 열람하지 않았고, 위의 공개 구현과 문서로 간접 참고 |

### Project Nayuki — QR Code generator library (MIT License)
출처: https://www.nayuki.io/page/qr-code-generator-library , https://github.com/nayuki/QR-Code-generator

Copyright (c) Project Nayuki. (MIT License)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:
- The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.
- The Software is provided "as is", without warranty of any kind, express or
  implied, including but not limited to the warranties of merchantability,
  fitness for a particular purpose and noninfringement. In no event shall the
  authors or copyright holders be liable for any claim, damages or other
  liability, whether in an action of contract, tort or otherwise, arising from,
  out of or in connection with the Software or the use or other dealings in the
  Software.

## 3. 기획 단계에서 참고 후보로 지정했지만 코드는 사용하지 않은 저장소
| 저장소 | 라이선스 |
|---|---|
| Authenticator-Extension/Authenticator — https://github.com/Authenticator-Extension/Authenticator | MIT |
| authenticator-sh/2fa — https://github.com/authenticator-sh/2fa | MIT (제3자 목록 기준. 원문은 저장소의 LICENSE 파일에서 확인) |

초기 기획서는 이 두 저장소를 먼저 분석(Phase 0)한 뒤 개발하도록 계획했지만, 실제 개발에서는 그 분석을 거치지 않았고 두 저장소의 소스 코드는 읽거나 복사하거나 의존하지 않았습니다. 두 프로젝트는 "무엇을 만들 수 있는가"에 대한 기획상의 참고였습니다. 이 프로젝트에 그 코드가 들어 있지 않으므로 해당 MIT 고지는 이 프로젝트의 배포에 요구되지 않으며, 나중에 코드를 가져오게 되면 원본의 저작권·라이선스 고지를 그대로 보존해야 합니다.

## 4. 개발·시험에만 쓰는 도구 (배포물에 포함되지 않음)
| 도구 | 용도 | 라이선스 |
|---|---|---|
| Node.js | 자동 시험 실행 | MIT 계열 |
| Python 3 | 빌드 스크립트(`build.py`), 시험 자료 생성 | PSF License |
| Pillow (선택) | `tests/make_qr.py`의 이미지 출력 | HPND |
| cryptography (선택) | `tests/make_argon2_vectors.py`로 Argon2id 정답값 생성 | Apache-2.0 또는 BSD-3-Clause |

## 5. 상표
Google, Google Authenticator는 Google LLC의 상표입니다. Microsoft, Microsoft Authenticator는 Microsoft Corporation의 상표입니다. QR Code는 DENSO WAVE INCORPORATED의 등록상표입니다. Chrome, Edge, Firefox, Safari 등 제품명은 각 소유자의 상표입니다. 이 프로젝트는 위 회사들과 제휴·후원·보증 관계가 없으며, 이름은 호환성을 설명하려는 목적으로만 사용합니다.

## 6. 아이콘
`assets/icon-source.png`, `assets/icon-source-transparent.png`, `extension/icons/*.png`는 프로젝트 소유자가 제공한 이미지에서 만든 것입니다(크기 조정과 바깥 배경 투명 처리만 했고 디자인은 바꾸지 않았습니다). 이 이미지의 저작권과 이용 조건(예: 생성 도구의 약관)은 제공자가 확인해야 하며, 이 프로젝트의 MIT 라이선스가 이 이미지에까지 적용되는지는 소유자가 결정합니다.
