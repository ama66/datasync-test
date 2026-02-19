FROM node:20

WORKDIR /app

COPY package.json .
COPY tsconfig.json .

RUN npm install
RUN npm install --save-dev @types/pg @types/node

COPY src ./src

RUN npm run build

CMD ["npm", "start"]