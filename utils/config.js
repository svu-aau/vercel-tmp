import * as dotenv from 'dotenv' // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import
dotenv.config({path: `.env.${process.env.NODE_ENV || 'development'}`});