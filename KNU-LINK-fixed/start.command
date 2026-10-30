#!/bin/bash
# KNU LINK macOS launcher (run via Finder double-click)
cd "$(dirname "$0")" || exit 1
printf '\n=== KNU LINK 로컬 서버 시작 ===\n\n'
fail() {
  printf '\n[오류] %s\n' "$1"
  printf '\nEnter를 누르면 창을 닫습니다.\n'
  read -r _unused
  exit 1
}
command -v python3 >/dev/null 2>&1 || fail 'Python 3이 설치되지 않았습니다. Python 3.10 이상을 설치해 주세요.'
for f in index.html styles.css app.js server.py requirements.txt; do
  [ -f "$f" ] || fail "$f 파일이 없습니다. ZIP 압축을 해제한 뒤 파일 이름을 변경하지 말아 주세요."
done
if [ ! -f .venv/bin/python ]; then
  echo 'Python 가상환경을 생성합니다.'
  python3 -m venv .venv || fail 'Python 가상환경을 만들지 못했습니다.'
fi
if ! .venv/bin/python -c 'import aiohttp' >/dev/null 2>&1; then
  echo '최초 실행에 필요한 서버 라이브러리를 설치합니다.'
  .venv/bin/python -m pip install -r requirements.txt || fail 'aiohttp 설치 실패. 인터넷 연결을 확인해 주세요.'
fi
if .venv/bin/python -c 'import socket; s=socket.socket(); s.settimeout(.5); rc=s.connect_ex(("127.0.0.1",8765)); s.close(); raise SystemExit(0 if rc==0 else 1)' ; then
  printf '\n8765 포트가 이미 사용 중입니다. 기존 서버가 있다면 기존 서버를 종료한 뒤 다시 실행하세요.\n'
  if command -v open >/dev/null 2>&1; then open 'http://localhost:8765'; fi
  fail '8765 포트가 사용 중이라 새 서버를 실행할 수 없습니다.'
fi
printf '\n브라우저 주소: http://localhost:8765\n이 터미널 창을 닫으면 서버도 종료됩니다.\n\n'
( sleep 2; if command -v open >/dev/null 2>&1; then open 'http://localhost:8765'; fi ) &
.venv/bin/python -u server.py
status=$?
printf '\n서버가 종료되었습니다 (종료 코드: %s).\n' "$status"
printf 'Enter를 누르면 창을 닫습니다.\n'
read -r _unused
exit "$status"
