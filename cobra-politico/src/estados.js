'use strict';

// As 27 unidades federativas. `bandeira` é o nome do arquivo no Wikimedia
// Commons (servido via /api/img, que só aceita hosts conhecidos).
const ESTADOS = [
  { uf: 'AC', nome: 'Acre', regiao: 'Norte', bandeira: 'Bandeira do Acre.svg', cores: ['#1a8f3c', '#f7d116'] },
  { uf: 'AL', nome: 'Alagoas', regiao: 'Nordeste', bandeira: 'Bandeira de Alagoas.svg', cores: ['#d52b1e', '#2b4a9b'] },
  { uf: 'AP', nome: 'Amapá', regiao: 'Norte', bandeira: 'Bandeira do Amapá.svg', cores: ['#1a8f3c', '#1d4f9a'] },
  { uf: 'AM', nome: 'Amazonas', regiao: 'Norte', bandeira: 'Bandeira do Amazonas.svg', cores: ['#d52b1e', '#1d4f9a'] },
  { uf: 'BA', nome: 'Bahia', regiao: 'Nordeste', bandeira: 'Bandeira da Bahia.svg', cores: ['#1d4f9a', '#d52b1e'] },
  { uf: 'CE', nome: 'Ceará', regiao: 'Nordeste', bandeira: 'Bandeira do Ceará.svg', cores: ['#1a8f3c', '#f7d116'] },
  { uf: 'DF', nome: 'Distrito Federal', regiao: 'Centro-Oeste', bandeira: 'Bandeira do Distrito Federal (Brasil).svg', cores: ['#1a8f3c', '#f7d116'] },
  { uf: 'ES', nome: 'Espírito Santo', regiao: 'Sudeste', bandeira: 'Bandeira do Espírito Santo.svg', cores: ['#1d4f9a', '#e88fb4'] },
  { uf: 'GO', nome: 'Goiás', regiao: 'Centro-Oeste', bandeira: 'Bandeira de Goiás.svg', cores: ['#1a8f3c', '#f7d116'] },
  { uf: 'MA', nome: 'Maranhão', regiao: 'Nordeste', bandeira: 'Bandeira do Maranhão.svg', cores: ['#d52b1e', '#1d4f9a'] },
  { uf: 'MT', nome: 'Mato Grosso', regiao: 'Centro-Oeste', bandeira: 'Bandeira de Mato Grosso.svg', cores: ['#1d4f9a', '#1a8f3c'] },
  { uf: 'MS', nome: 'Mato Grosso do Sul', regiao: 'Centro-Oeste', bandeira: 'Bandeira de Mato Grosso do Sul.svg', cores: ['#1a8f3c', '#1d4f9a'] },
  { uf: 'MG', nome: 'Minas Gerais', regiao: 'Sudeste', bandeira: 'Bandeira de Minas Gerais.svg', cores: ['#d52b1e', '#444444'] },
  { uf: 'PA', nome: 'Pará', regiao: 'Norte', bandeira: 'Bandeira do Pará.svg', cores: ['#d52b1e', '#1d4f9a'] },
  { uf: 'PB', nome: 'Paraíba', regiao: 'Nordeste', bandeira: 'Bandeira da Paraíba.svg', cores: ['#d52b1e', '#222222'] },
  { uf: 'PR', nome: 'Paraná', regiao: 'Sul', bandeira: 'Bandeira do Paraná.svg', cores: ['#1a8f3c', '#1d4f9a'] },
  { uf: 'PE', nome: 'Pernambuco', regiao: 'Nordeste', bandeira: 'Bandeira de Pernambuco.svg', cores: ['#1d4f9a', '#f7d116'] },
  { uf: 'PI', nome: 'Piauí', regiao: 'Nordeste', bandeira: 'Bandeira do Piauí.svg', cores: ['#1a8f3c', '#f7d116'] },
  { uf: 'RJ', nome: 'Rio de Janeiro', regiao: 'Sudeste', bandeira: 'Bandeira do estado do Rio de Janeiro.svg', cores: ['#1d4f9a', '#888888'] },
  { uf: 'RN', nome: 'Rio Grande do Norte', regiao: 'Nordeste', bandeira: 'Bandeira do Rio Grande do Norte.svg', cores: ['#1a8f3c', '#f7d116'] },
  { uf: 'RS', nome: 'Rio Grande do Sul', regiao: 'Sul', bandeira: 'Bandeira do Rio Grande do Sul.svg', cores: ['#1a8f3c', '#d52b1e'] },
  { uf: 'RO', nome: 'Rondônia', regiao: 'Norte', bandeira: 'Bandeira de Rondônia.svg', cores: ['#1d4f9a', '#1a8f3c'] },
  { uf: 'RR', nome: 'Roraima', regiao: 'Norte', bandeira: 'Bandeira de Roraima.svg', cores: ['#1d4f9a', '#1a8f3c'] },
  { uf: 'SC', nome: 'Santa Catarina', regiao: 'Sul', bandeira: 'Bandeira de Santa Catarina.svg', cores: ['#d52b1e', '#1a8f3c'] },
  { uf: 'SP', nome: 'São Paulo', regiao: 'Sudeste', bandeira: 'Bandeira do estado de São Paulo.svg', cores: ['#d52b1e', '#222222'] },
  { uf: 'SE', nome: 'Sergipe', regiao: 'Nordeste', bandeira: 'Bandeira de Sergipe.svg', cores: ['#1a8f3c', '#1d4f9a'] },
  { uf: 'TO', nome: 'Tocantins', regiao: 'Norte', bandeira: 'Bandeira do Tocantins.svg', cores: ['#1d4f9a', '#f7d116'] },
];

const POR_UF = Object.fromEntries(ESTADOS.map((e) => [e.uf, e]));

function bandeiraUrl(uf, largura = 320) {
  const e = POR_UF[uf];
  if (!e) return null;
  const arquivo = encodeURIComponent(e.bandeira.replace(/ /g, '_'));
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${arquivo}?width=${largura}`;
}

function estadoPublico(e) {
  return { uf: e.uf, nome: e.nome, regiao: e.regiao, cores: e.cores, bandeira: bandeiraUrl(e.uf) };
}

function isUf(uf) {
  return typeof uf === 'string' && Object.prototype.hasOwnProperty.call(POR_UF, uf);
}

module.exports = { ESTADOS, POR_UF, bandeiraUrl, estadoPublico, isUf };
