FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py ./

RUN useradd --system --uid 10001 --create-home gateway \
 && mkdir -p /data \
 && chown gateway:gateway /data
USER gateway

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "/app/agent.py", "status", "--db", "/data/queue.db"]

CMD ["python", "-u", "/app/agent.py", "run"]
