FROM node:18-alpine

WORKDIR /app

# Copiar package.json e instalar dependências
COPY package*.json ./
RUN npm install

# Copiar arquivos do projeto
COPY . .

# Compilar TypeScript
RUN npm run build

# Definir comando padrão
CMD ["node", "dist/index.js"] 