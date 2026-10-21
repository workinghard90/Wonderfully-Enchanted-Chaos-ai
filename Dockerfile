FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENV WEC_PIPER_MODEL=/opt/wec-voices/en_US-ljspeech-high.onnx OMP_NUM_THREADS=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml README.md ./
COPY wec_engine ./wec_engine
RUN pip install --no-cache-dir ".[narration]" "piper-tts==1.8.0" && python -m wec_engine.download_voice /opt/wec-voices && useradd -m -u 10001 wec && mkdir -p /var/data && chown wec:wec /var/data
USER wec
EXPOSE 8765
CMD ["sh", "-c", "exec wec-studio --host 0.0.0.0 --port ${PORT:-8765} --data-dir ${WEC_DATA_DIR:-/var/data}"]
