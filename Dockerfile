# Sử dụng Node 20 có đầy đủ Debian libs
FROM node:20

# Cài công cụ build & các thư viện cần thiết
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    cmake \
    git \
    pkg-config \
    wget \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Thư mục làm việc
WORKDIR /usr/src/app

# Sao chép file package
COPY package*.json ./

# Cài dependencies
RUN npm install

# Sao chép code
COPY . .

# Mở port proxy (8000 cho WS, 3333 cho xmrig-proxy nội bộ)
EXPOSE 8000

# Chạy proxy bằng npm start
CMD ["npm", "start"]
