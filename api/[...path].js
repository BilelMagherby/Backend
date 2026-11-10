import { handleVercelRequest } from '../src/server.js'

export const config = {
  api: {
    bodyParser: false,
  },
}

export default handleVercelRequest
