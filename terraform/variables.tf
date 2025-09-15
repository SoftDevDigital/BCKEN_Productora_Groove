variable "use_local" {
  description = "Usar LocalStack para pruebas locales"
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Nombre del dominio personalizado (ej: tudominio.com)"
  type        = string
  default     = "tudominio.com"  # Reemplaza con tu dominio real o usa un subdominio de prueba
}