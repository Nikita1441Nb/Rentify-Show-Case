# Stage 1: Build dependencies
FROM python:3.10-slim as builder

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

RUN apt-get update && apt-get install -y --no-install-recommends gcc python3-dev

COPY requirements.txt .
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /app/wheels -r requirements.txt

# Stage 2: Final image
FROM python:3.10-slim

WORKDIR /app

COPY --from=builder /app/wheels /wheels
COPY --from=builder /app/requirements.txt .

RUN pip install --no-cache /wheels/*

# Копируем проект
COPY . .

# Создаем пользователя для безопасности (не запускаем от root)
RUN useradd -m rentify_user && chown -R rentify_user:rentify_user /app
USER rentify_user

CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000"]
