# DocMint — fill DOCX/XLSX/PPTX templates, optionally convert to PDF.
# One container: the fill engine, the PDF converter, the API, the site and the docs.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    HOME=/tmp

WORKDIR /app

COPY package.json package-lock.json ./

# LibreOffice is the only reason this image is large: it adds about 700 MB to a
# 200 MB base. Only the three format filters we actually convert are installed —
# writer, calc and impress — and not libreoffice-core's optional extras, which is
# worth roughly another 300 MB we would never execute.
#
# The fonts matter more than they look. A template written in Calibri, converted
# on a machine that has never heard of Calibri, comes out in a fallback face with
# different metrics: the table columns shift, a heading wraps onto two lines, and
# the customer's letterhead is subtly wrong. Carlito and Caladea are metric-
# compatible substitutes for Calibri and Cambria, which are the default Office
# fonts and therefore what most templates use.
RUN npm ci --omit=dev \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      default-jre-headless \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-liberation2 \
      fonts-dejavu-core \
      fonts-noto-core \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
 && fc-cache -f \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm

COPY src ./src
COPY public ./public

# The service parses zip archives and XML uploaded by strangers, and hands them to
# LibreOffice, which is a very large C++ program. Neither should ever be running
# as root. /tmp is the only path this user needs to write, which is where both the
# LibreOffice profile and the per-conversion scratch directory live.
RUN groupadd --system --gid 10001 docmint \
 && useradd --system --uid 10001 --gid docmint --home-dir /home/docmint --create-home docmint \
 && chown -R docmint:docmint /home/docmint
USER docmint

# Pay the LibreOffice first-run profile cost once, at build time, instead of on
# the first customer request. Measured: 1.25 s cold against 1.02 s warm.
RUN mkdir -p /tmp/docmint-lo-profile \
 && (soffice --headless --norestore --nolockcheck --nodefault --nofirststartwizard \
      -env:UserInstallation=file:///tmp/docmint-lo-profile --version || true)

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
