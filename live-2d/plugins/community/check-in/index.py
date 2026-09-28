"""
定时问候插件

每隔 N 秒让 AI 主动发起一次对话，问用户在做什么。
用 asyncio 定时器实现，完全后台运行。
"""

import asyncio
from plugin_sdk import Plugin, run

PROMPT = 'You notice the user has not said anything for a while. Casually ask what they are up to, in your usual style. No need to be formal.'


class CheckInPlugin(Plugin):

    async def on_start(self):
        cfg = self.context.get_plugin_config()
        self._interval = cfg.get('interval', 20)
        self._task = asyncio.create_task(self._loop())

    async def on_stop(self):
        if hasattr(self, '_task'):
            self._task.cancel()

    async def _loop(self):
        try:
            while True:
                await asyncio.sleep(self._interval)
                self.context.send_message(PROMPT)
        except asyncio.CancelledError:
            pass


if __name__ == '__main__':
    run(CheckInPlugin)
