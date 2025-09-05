# Backend para Venta de Entradas y Base de Revendedores

Backend serverless 100% AWS con Nest.js, siguiendo el plan del PDF (B-01.pdf). Este README resume el setup inicial (Día 1 hasta Parte 4) para nuevos desarrolladores.

## Resumen
Proyecto para sistema de tickets con QR y gestión de revendedores. Usa Nest.js en Lambda, DynamoDB, S3, Cognito, etc. Configurado con Terraform para IaC y LocalStack para pruebas locales.

## Setup Inicial Realizado
### Parte 1: Instalaciones Globales
- **Por qué**: Herramientas base para desarrollo, IaC y pruebas.
- Comandos: Ver setup-guide.md para detalles de instalación (Node, Nest CLI, Terraform, Docker, AWS CLI).

### Parte 2: Estructura y Dependencias
- **Por qué**: Organiza código en módulos, agrega libs mínimas para AWS y QR.
- Carpetas: src/ (con auth, tickets, etc.), terraform/, tests/, volume/.
- Archivos: docker-compose.yml (LocalStack), serverless.yml (empaquetado Lambda), .env.example, README.md.
- Comandos: `npm install aws-sdk qrcode`; `npm run start:dev` para correr local.

### Parte 3: LocalStack y AWS CLI
- **Por qué**: Simula AWS localmente para dev sin costos.
- Comandos: `docker compose up -d` para iniciar; configura .aws/config y credentials con perfil localstack.
- Verificar: `aws --profile localstack --endpoint-url=http://localhost:4566 s3 ls`.

### Parte 4: Terraform (IaC)
- **Por qué**: Define recursos AWS reproducibles (S3, DB, API, Pipeline, etc.).
- Archivos en terraform/: providers.tf, variables.tf, main.tf.
- Comandos: `cd terraform && terraform init`; `terraform apply`.

## Cómo Levantar el Entorno
- Local (Nest.js solo): `npm run start:dev`.
- LocalStack: `docker compose up -d`.
- Recursos IaC: `cd terraform && terraform apply`.

## Alternar LocalStack vs AWS Real
- **LocalStack**: Descomenta endpoints en providers.tf; usa `terraform apply -var 'use_local=true'`; AWS CLI con --profile localstack.
- **AWS Real**: Comenta endpoints; usa credenciales reales en `aws configure`; `terraform apply`.
- Nota: Para dominio, registra en Route 53 manualmente en AWS real.

## Referencias
- Plan: B-01.pdf.
- Guía detallada: Ver setup-guide.md en Drive.
- Próximo: Completar Día 1 (despliegue Lambda) y días siguientes.

Mantén Git para versionado: `git init && git add . && git commit -m "Setup inicial"`.