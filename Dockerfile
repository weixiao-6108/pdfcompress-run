FROM node:18-slim

# 安装核心工具：
#   ghostscript  : 页面增删、转图片仍使用 gs
#   qpdf         : 轻度压缩只做结构优化（不重编码字体/图片，避免乱码）
#   poppler-utils: 提供 pdftoppm，中/重度整页栅格化（自动处理页面旋转）
#   wqy 字体     : 辅助 gs 找不到字体时的中文渲染
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ghostscript \
     qpdf \
     poppler-utils \
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

