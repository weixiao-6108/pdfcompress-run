FROM node:18-slim

# 安装 ghostscript（核心压缩引擎）+ 中文字体（避免中文乱码）
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ghostscript \
     fonts-wqy-zenhei \
     fonts-wqy-microhei \
  && rm -rf /var/lib/apt/lists/*

# 让 Ghostscript 能找到系统字体
ENV GS_FONTPATH=/usr/share/fonts

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
