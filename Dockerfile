# صورة تشغيل النظام (Railway أو أي خادم يدعم Docker)
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# البيانات والمرفقات والنسخ الاحتياطية على قرص دائم يُربط بهذا المسار
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "src/server.js"]
