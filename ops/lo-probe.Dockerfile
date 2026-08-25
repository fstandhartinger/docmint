# Probe image: measure what headless LibreOffice actually costs.
FROM node:20-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      default-jre-headless \
      fonts-liberation2 fonts-dejavu-core fonts-noto-core \
      procps time \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /probe
CMD ["bash"]
