FROM python:3.11-slim

WORKDIR /srv/fretes

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY fretes ./fretes

ENV FRETES_DB_PATH=/srv/fretes/data/fretes.db
VOLUME /srv/fretes/data
EXPOSE 8100

CMD ["uvicorn", "fretes.main:app", "--host", "0.0.0.0", "--port", "8100"]
