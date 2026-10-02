FROM public.ecr.aws/docker/library/node@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend-v3/package.json frontend-v3/package-lock.json ./frontend-v3/
RUN npm --prefix frontend-v3 ci
COPY . .
RUN npm run build

FROM public.ecr.aws/docker/library/node@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff AS runtime-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM public.ecr.aws/docker/library/node@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/web ./dist/web
COPY package.json package-lock.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server/src/server/main.js"]
