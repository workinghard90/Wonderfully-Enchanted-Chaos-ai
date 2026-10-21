FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml README.md ./
COPY wec_engine ./wec_engine
RUN pip install --no-cache-dir . && useradd -m -u 10001 wec && mkdir -p /var/data && chown wec:wec /var/data
USER wec
EXPOSE 8765
CMD ["sh", "-c", "exec wec-studio --host 0.0.0.0 --port ${PORT:-8765} --data-dir ${WEC_DATA_DIR:-/var/data}"]
