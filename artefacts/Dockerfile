# syntax=docker/dockerfile:1
# Image du serveur d'artefacts : Python (bibliothèque standard seulement) + le « kit » de bibliothèques épinglées.
# Le kit est reconstruit à la construction de l'image par maj-kit.py : versions et empreintes sha512 du fichier
# kit.lock.json vérifiées contre le registre npm, avis de sécurité interrogés. Aucun CDN à l'exécution.

FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS kit
WORKDIR /build
COPY maj-kit.py kit.lock.json ./
COPY kit-local ./kit-local
RUN python maj-kit.py

FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY app /app
COPY --from=kit /build/kit /kit
CMD ["python", "-u", "/app/art.py"]
