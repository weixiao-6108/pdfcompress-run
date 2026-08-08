FROM node:18-slim

# 安装 ghostscript（核心压缩引擎）
RUN apt-get update \
  && apt-get install -y --no-install-recommends ghostscript \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
