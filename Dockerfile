# Usa una imagen oficial de Node.js
FROM node:18

# Establece el directorio de trabajo en el contenedor
WORKDIR /app

# Copia los archivos de configuración primero para aprovechar la caché
COPY package*.json ./

# Instala dependencias
RUN npm install

# Copia el resto de la aplicación
COPY . .

# Expón el puerto que usas en el server.js (ej: 3000)
EXPOSE 3000

# Comando para arrancar la app
CMD ["node", "server.js"]
