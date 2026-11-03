FROM python:3.12-alpine
RUN pip install --no-cache-dir pytest==8.3.4
RUN adduser -D -u 1000 runner && mkdir -p /workspace/repo /workspace/scratch && chown -R 1000:1000 /workspace
USER 1000:1000
