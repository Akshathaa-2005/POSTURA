# Build from the repo root so the shared exercise database is available:
#   docker compose -f backend/docker-compose.yml up --build
FROM python:3.11-slim

# eSpeak NG is pyttsx3's offline speech engine on Linux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY exercises/ /exercises/
ENV EXERCISES_PATH=/exercises/exercises.json

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
