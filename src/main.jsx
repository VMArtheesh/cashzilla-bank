import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import '@fontsource-variable/inter';
import Portal from './Portal';
import bank from './bank-config';
import './style.css';

document.title = bank.name + ' | Banking portal';
const theme = createTheme({
  palette: { primary: { main: '#123c3a' }, background: { default: '#f7f6f1', paper: '#ffffff' } },
  shape: { borderRadius: 8 },
  typography: { fontFamily: '"Inter Variable", Inter, sans-serif', button: { textTransform: 'none', fontWeight: 650 } },
  components: { MuiButton: { defaultProps: { disableElevation: true } } },
});

createRoot(document.getElementById('root')).render(
  <ThemeProvider theme={theme}><CssBaseline /><Portal bank={bank} switchUrl="https://sriramtpsiog.github.io/SharedDB/" /></ThemeProvider>,
);
