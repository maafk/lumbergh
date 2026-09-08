import asyncio

import lumbergh.routers.glasses as glasses


class FakeUpstream:
    """Records what the proxy forwarded, and replays scripted frames back."""

    def __init__(self, replies=()):
        self.sent = []
        self._replies = list(replies)

    async def send(self, data):
        self.sent.append(data)

    def __aiter__(self):
        async def gen():
            for frame in self._replies:
                yield frame

        return gen()


class FakeClient:
    def __init__(self, messages):
        self._messages = list(messages)
        self.text = []
        self.bytes = []

    async def receive(self):
        if self._messages:
            return self._messages.pop(0)
        return {"type": "websocket.disconnect"}

    async def send_text(self, data):
        self.text.append(data)

    async def send_bytes(self, data):
        self.bytes.append(data)


def _settings(monkeypatch, value):
    import lumbergh.routers.settings as settings_mod

    monkeypatch.setattr(settings_mod, "get_settings", lambda: value)


def test_stt_target_defaults_to_the_blurt_host(monkeypatch):
    _settings(monkeypatch, {})
    assert glasses._stt_target() == ("llmbox", 9091)


def test_stt_target_honours_configuration(monkeypatch):
    _settings(monkeypatch, {"glasses": {"stt": {"host": "otherbox", "port": 9200}}})
    assert glasses._stt_target() == ("otherbox", 9200)


def test_stt_target_survives_a_non_numeric_port(monkeypatch):
    _settings(monkeypatch, {"glasses": {"stt": {"port": "not-a-port"}}})
    assert glasses._stt_target() == ("llmbox", 9091)


def test_stt_target_survives_unreadable_settings(monkeypatch):
    import lumbergh.routers.settings as settings_mod

    def boom():
        raise RuntimeError("settings on fire")

    monkeypatch.setattr(settings_mod, "get_settings", boom)
    assert glasses._stt_target() == ("llmbox", 9091)


async def test_pump_preserves_the_json_handshake_as_text():
    """WhisperLive discards the stream if its config frame arrives as binary."""
    upstream = FakeUpstream()
    client = FakeClient([{"type": "websocket.receive", "text": '{"uid":"x"}'}])
    await glasses._pump_to_upstream(client, upstream)
    assert upstream.sent == ['{"uid":"x"}']


async def test_pump_preserves_audio_as_binary():
    upstream = FakeUpstream()
    client = FakeClient([{"type": "websocket.receive", "bytes": b"\x00\x01\x02"}])
    await glasses._pump_to_upstream(client, upstream)
    assert upstream.sent == [b"\x00\x01\x02"]


async def test_pump_stops_when_the_client_hangs_up():
    upstream = FakeUpstream()
    client = FakeClient(
        [
            {"type": "websocket.receive", "text": "first"},
            {"type": "websocket.disconnect"},
            {"type": "websocket.receive", "text": "never"},
        ]
    )
    await asyncio.wait_for(glasses._pump_to_upstream(client, upstream), timeout=1)
    assert upstream.sent == ["first"]


async def test_transcripts_come_back_to_the_client_as_text():
    upstream = FakeUpstream(replies=['{"segments":[{"text":"hello"}]}', b"\x07"])
    client = FakeClient([])
    await glasses._pump_to_client(client, upstream)
    assert client.text == ['{"segments":[{"text":"hello"}]}']
    assert client.bytes == [b"\x07"]
