#!/usr/bin/env python3
"""KNU LINK prototype: realtime matching and WebRTC signaling server.

Requires aiohttp (pip install -r requirements.txt). No university verification.
All users/queues/matches exist only in server memory. Reports are saved locally.
"""
import argparse
import asyncio
from collections import defaultdict, deque
from datetime import datetime, timezone
import json
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit
from aiohttp import web, WSMsgType

ROOT = Path(__file__).resolve().parent
MODES = {"friend", "date", "random", "connect"}
REPORT_REASONS = {"harassment", "sexual", "spam", "hate", "other"}


class Participant:
    def __init__(self, ws):
        self.ws = ws
        self.id = secrets.token_hex(8)
        self.name = "익명 학생"
        self.mode = None
        self.interests = []
        self.status = "idle"
        self.peer = None
        self.initiator = False
        self.match_id = None
        self.audio_ready = False
        self.camera_intent = False
        self.friend_requested = False
        self.blocked = set()
        self.last_chat = 0.0

    async def send(self, event, **data):
        if not self.ws.closed:
            try:
                await self.ws.send_json({"type": event, **data})
            except (ConnectionResetError, RuntimeError):
                pass


class MatchService:
    def __init__(self):
        self.users = {}
        self.queues = defaultdict(deque)
        self.lock = asyncio.Lock()
        self.report_path = ROOT / "data" / "reports.jsonl"

    async def stats(self):
        online = len(self.users)
        queues = {mode: sum(1 for u in self.queues[mode] if u.id in self.users and u.status == "searching") for mode in MODES}
        for user in list(self.users.values()):
            await user.send("stats", online=online, queues=queues)

    def dequeue(self, user):
        if user.mode is not None:
            q = self.queues[user.mode]
            try:
                q.remove(user)
            except ValueError:
                pass

    async def detach(self, user, reason="상대방이 연결을 종료했어요."):
        self.dequeue(user)
        peer = user.peer
        user.peer = None
        user.match_id = None
        user.audio_ready = False
        user.camera_intent = False
        user.friend_requested = False
        user.status = "idle"
        if peer and peer.peer is user:
            peer.peer = None
            peer.match_id = None
            peer.audio_ready = False
            peer.camera_intent = False
            peer.friend_requested = False
            peer.status = "idle"
            await peer.send("peer-left", message=reason)

    async def begin_search(self, user, data):
        mode = str(data.get("mode", ""))
        if mode not in MODES:
            return await user.send("error", message="올바른 매칭 모드를 선택해 주세요.")
        if mode == "date" and data.get("adultConfirmed") is not True:
            return await user.send("error", message="소개팅 모드는 성인 확인 동의가 필요해요. 데모에는 실제 나이 인증이 없어요.")
        await self.detach(user)
        user.mode = mode
        user.name = str(data.get("name", "익명 학생")).strip()[:24] or "익명 학생"
        interests = data.get("interests", [])
        user.interests = [str(x)[:20] for x in interests[:8] if isinstance(x, str)] if isinstance(interests, list) else []
        user.status = "searching"
        queue = self.queues[mode]
        match = None
        for candidate in list(queue):
            if candidate.id not in self.users or candidate.status != "searching":
                self.dequeue(candidate)
                continue
            if candidate.id in user.blocked or user.id in candidate.blocked:
                continue
            match = candidate
            self.dequeue(candidate)
            break
        if match:
            user.peer = match
            match.peer = user
            user.match_id = match.match_id = secrets.token_hex(10)
            user.status = match.status = "paired"
            user.initiator = False
            match.initiator = True
            for u, other in [(user, match), (match, user)]:
                await u.send("paired", matchId=u.match_id, initiator=u.initiator,
                             partner={"id":other.id, "name":other.name, "interests":other.interests})
        else:
            queue.append(user)
            await user.send("searching", mode=mode)
        await self.stats()

    async def handle(self, user, data):
        kind = data.get("type")
        if kind == "search":
            return await self.begin_search(user, data)
        if kind == "cancel":
            await self.detach(user)
            await user.send("idle")
            return await self.stats()
        if kind == "next":
            if not user.mode:
                return await user.send("idle")
            payload = {"mode": user.mode, "name": user.name, "interests": user.interests, "adultConfirmed": data.get("adultConfirmed") is True}
            await self.detach(user, "상대방이 다음 매칭으로 이동했어요.")
            return await self.begin_search(user, payload)
        if user.status != "paired" or not user.peer or user.peer.peer is not user:
            return await user.send("error", message="먼저 상대방과 매칭해 주세요.")
        peer = user.peer
        if kind == "chat":
            message = str(data.get("message", "")).strip()[:1000]
            if not message:
                return
            if time.monotonic() - user.last_chat < 0.25:
                return await user.send("error", message="메시지를 너무 빠르게 보내고 있어요.")
            user.last_chat = time.monotonic()
            await peer.send("chat", message=message, sentAt=datetime.now(timezone.utc).isoformat())
            return
        if kind == "audio-ready":
            user.audio_ready = True
            for a,b in ((user,peer),(peer,user)):
                await a.send("audio-status", mine=a.audio_ready, peer=b.audio_ready)
            return
        if kind == "camera-intent":
            user.camera_intent = data.get("enabled") is True
            for a,b in ((user,peer),(peer,user)):
                await a.send("camera-status", mine=a.camera_intent, peer=b.camera_intent)
            return
        if kind == "signal":
            signal = data.get("signal")
            if isinstance(signal, dict) and signal.get("kind") in {"offer", "answer", "candidate", "renegotiate"}:
                await peer.send("signal", signal=signal)
            return
        if kind == "friend-request":
            user.friend_requested = True
            await user.send("friend-pending")
            await peer.send("friend-requested")
            if peer.friend_requested:
                await user.send("friend-match", partner={"name":peer.name,"mode":user.mode})
                await peer.send("friend-match", partner={"name":user.name,"mode":peer.mode})
            return
        if kind == "block":
            user.blocked.add(peer.id)
            await self.detach(user, "상대방이 연결을 종료했어요.")
            await user.send("blocked", message="차단했어요. 이 접속 중에는 다시 매칭되지 않아요.")
            return await self.stats()
        if kind == "report":
            reason = str(data.get("reason", "other"))
            if reason not in REPORT_REASONS:
                reason = "other"
            self.report_path.parent.mkdir(parents=True, exist_ok=True)
            record = {"time":datetime.now(timezone.utc).isoformat(), "reporterSession":user.id,
                      "reportedSession":peer.id, "matchId":user.match_id, "reason":reason}
            with self.report_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
            user.blocked.add(peer.id)
            await self.detach(user, "상대방이 연결을 종료했어요.")
            await user.send("reported", message="신고가 이 서버의 로컬 기록에 접수됐어요. 데모에는 운영자 심사 기능이 없습니다.")
            return await self.stats()


service = MatchService()

async def ws_handler(request):
    origin = request.headers.get("Origin")
    if origin and urlsplit(origin).netloc != request.host:
        raise web.HTTPForbidden(text="Only same-origin websocket connections are allowed")
    ws = web.WebSocketResponse(heartbeat=20.0, max_msg_size=65536)
    await ws.prepare(request)
    user = Participant(ws)
    async with service.lock:
        service.users[user.id] = user
        await user.send("hello", sessionId=user.id, verified=False)
        await service.stats()
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    if not isinstance(data, dict):
                        continue
                except (json.JSONDecodeError, ValueError):
                    await user.send("error", message="메시지 형식이 올바르지 않아요.")
                    continue
                async with service.lock:
                    try:
                        await service.handle(user, data)
                    except Exception:
                        await user.send("error", message="서버 처리 중 문제가 발생했습니다.")
                        raise
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        async with service.lock:
            await service.detach(user, "상대방의 접속이 끊어졌어요.")
            service.users.pop(user.id, None)
            await service.stats()
    return ws


async def index(request):
    return web.FileResponse(ROOT / "index.html")


async def asset(request):
    name = request.match_info['name']
    if name not in {"app.js", "styles.css", "favicon.svg", "manifest.webmanifest"}:
        raise web.HTTPNotFound()
    return web.FileResponse(ROOT / name)


def make_app():
    app = web.Application(client_max_size=128*1024)
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/{name}", asset)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    print(f"KNU LINK ▶ http://localhost:{args.port} (동일 컴퓨터의 브라우저 두 개로 테스트 가능)")
    web.run_app(make_app(), host=args.host, port=args.port, access_log=None)
