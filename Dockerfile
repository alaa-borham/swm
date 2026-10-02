# صورة تشغيل النظام (Railway أو أي خادم يدعم Docker)
# المرحلة 1: تثبيت الحزم مع أدوات التجميع (better-sqlite3 تُجمّع محليًا إن تعذر تنزيل النسخة الجاهزة)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# المرحلة 2: صورة التشغيل الخفيفة
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# البيانات والمرفقات والنسخ الاحتياطية على قرص دائم (Volume) مربوط بهذا المسار
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "src/server.js"]
