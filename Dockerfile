FROM public.ecr.aws/docker/library/node@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend-v3/package.json frontend-v3/package-lock.json ./frontend-v3/
RUN npm --prefix frontend-v3 ci
COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:web"]
