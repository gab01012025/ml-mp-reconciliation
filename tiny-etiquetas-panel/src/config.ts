export const config = {
  tinyToken: process.env.TINY_TOKEN || '4aa19f0ae99e08d9dcbd909d9c6f6b5314eca013882cc292950a69eb0ad75364',
  tinyApiUrl: 'https://api.tiny.com.br/api2',
  port: parseInt(process.env.PORT || '3002', 10),
};
