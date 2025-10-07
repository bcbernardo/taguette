import logging
import requests
import time


class LokiHandler(logging.Handler):

    def __init__(self, loki_url: str, job_name: str = "libreqda"):
        super().__init__()
        self.loki_url = f"{loki_url}/loki/api/v1/push"
        self.job_name = job_name
        self.buffer = []
        self.buffer_size = 10

    def emit(self, record):
        try:
            message = self.format(record)
            level = record.levelname.lower()

            labels = {
                "job": self.job_name,
                "level": level,
                "logger": record.name
            }

            if hasattr(record, 'user_id'):
                labels["user_id"] = str(record.user_id)
            if hasattr(record, 'project_id'):
                labels["project_id"] = str(record.project_id)

            timestamp = str(int(time.time() * 1000000000))

            self.buffer.append({
                "stream": labels,
                "values": [[timestamp, message]]
            })

            if len(self.buffer) >= self.buffer_size:
                self._send_buffer()

        except Exception:
            pass

    def _send_buffer(self):
        if not self.buffer:
            return

        try:
            payload = {"streams": self.buffer}
            response = requests.post(
                self.loki_url,
                json=payload,
                timeout=5
            )
            if response.status_code == 204:
                self.buffer.clear()
        except Exception:
            self.buffer.clear()

    def close(self):
        self._send_buffer()
        super().close()


def setup_loki_logging(loki_url: str):
    loki_handler = LokiHandler(loki_url)
    formatter = logging.Formatter("%(asctime)s %(levelname)s: %(message)s")
    loki_handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.addHandler(loki_handler)

    tornado_logger = logging.getLogger("tornado.access")
    tornado_logger.addHandler(loki_handler)

    return loki_handler
